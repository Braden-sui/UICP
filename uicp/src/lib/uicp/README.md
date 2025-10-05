# UICP Core Schemas

This package hosts the runtime schemas and adapter used by the desktop client to apply UICP Core commands. All payloads are validated with Zod before they reach the DOM so that planner mistakes remain contained.

## Envelope

```ts
{
  id?: string;            // optional UUID so the backend can respond to a specific command
  idempotencyKey?: string; // prevents duplicate application on reconnect
  windowId?: string;      // convenience mirror of params.windowId where applicable
  op: OperationName;      // "window.create" | ...
  params: OperationParamMap[op];
}
```

## Supported operations

| op                | params summary |
|-------------------|----------------|
| `window.create`   | `{ id?, title, x?, y?, width?, height?, zIndex?, size? }` |
| `window.update`   | `{ id, title?, x?, y?, width?, height?, zIndex? }` |
| `window.close`    | `{ id }` |
| `dom.set`         | `{ windowId, target, html, sanitize? }` |
| `dom.set`         | `{ windowId, target, html, sanitize? }` (alias: replace content) |
| `dom.replace`     | `{ windowId, target, html, sanitize? }` |
| `dom.append`      | same as replace |
| `component.render`| `{ id?, windowId, target, type, props? }` |
| `component.update`| `{ id, props }` |
| `component.destroy`| `{ id }` |
| `state.set`       | `{ scope, key, value, windowId?, ttlMs? }` |
| `state.get`       | `{ scope, key, windowId? }` |
| `state.watch` / `state.unwatch` | same as `state.get` |
| `api.call`        | `{ method, url, headers?, body?, idempotencyKey? }` |
| `txn.cancel`      | `{ id? }` |

The adapter maintains per-window DOM islands under `#workspace-root`. Commands are applied in FIFO order per window, coalesced into a single animation frame.

* `window.create` creates a draggable-ready shell with a header and content slot.
* `dom.*` operations mutate the content slot. HTML is sanitised to remove `<script>`/`<style>` tags, neutralise inline `on*` handlers, and strip `javascript:` URLs.
* `dom.set` is the preferred path for replacing the entire target subtree in one shot.
* `component.*` calls are mapped onto lightweight mock components so MOCK mode can emulate planner output.
* `state.*` stores values in memory to support planned future diffing. In MOCK mode watchers are inert.

## Error surface

Validation

* Planner plans are accepted in camelCase or snake_case and normalised.
* Validation failures raise `UICPValidationError` with:

```ts
{
  message: string;
  pointer: string; // JSON pointer describing the invalid field
  issues: z.ZodIssue[];
}
```

* The chat pipeline turns these into system messages and toast notifications, including a friendly hint derived from the JSON pointer, so silently ignored commands never occur.

## LLM Integration & Aggregation

Planner/Actor prompts live under `src/prompts/`. The provider (`lib/llm/provider.ts`) streams completions using the Tauri-backed Ollama bridge, and the orchestrator (`lib/llm/orchestrator.ts`) parses commentary-channel JSON into validated plans/batches.

### Aggregator

`createOllamaAggregator(onBatch?)` collects commentary-channel text and, on stream end, attempts to parse a `batch` from the buffer. When a valid batch is found:

- If `onBatch` is provided, it is called and may decide whether to auto-apply (`enqueueBatch`) or surface a preview (e.g., based on Full Control).
- If `onBatch` is not provided, the aggregator calls `enqueueBatch(batch)` by default.

The Tauri bridge installs an aggregator with a gating callback that:

- Suppresses auto-apply when the orchestrator is running (prevents duplicates) using an app-level `suppressAutoApply` flag.
- Auto-applies when Full Control is ON and not locked.
- Otherwise, sets a pending plan for preview in the chat state.

### STOP / Cancel

- The chat layer's STOP enqueues `txn.cancel` through the queue (clears pending work) and locks Full Control.
- The streaming transport supports best-effort cancellation: when the async iterator returned by `streamOllamaCompletion()` is closed, the frontend calls the Tauri command `cancel_chat(requestId)` to abort the backend HTTP request.
