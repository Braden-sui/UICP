# UICP Core Schemas

This package hosts the runtime schemas and adapter used by the desktop client to apply UICP Core commands. All payloads are validated with Zod before they reach the DOM so that planner mistakes remain contained.

## Envelope

```ts
{
  id?: string;            // optional UUID for response correlation
  idempotencyKey?: string; // prevents duplicate application on reconnect
  traceId?: string;       // request tracking identifier across system
  txnId?: string;         // transaction grouping identifier
  windowId?: string;      // convenience mirror of params.windowId where applicable
  op: OperationName;      // "window.create" | ...
  params: OperationParamMap[op];
}
```

## Supported operations

| op                | params summary |
|-------------------|----------------|
| `window.create`   | `{ id?, title, x?, y?, width?, height?, zIndex?, size? }` (size: "xs"\|"sm"\|"md"\|"lg"\|"xl", min width/height: 120px) |
| `window.update`   | `{ id, title?, x?, y?, width?, height?, zIndex? }` (min width/height: 120px) |
| `window.close`    | `{ id }` |
| `dom.set`         | `{ windowId, target, html, sanitize? }` (preferred full-target replace) |
| `dom.replace`     | `{ windowId, target, html, sanitize? }` (same shape, planner may use either) |
| `dom.append`      | same as replace |
| `component.render`| `{ id?, windowId, target, type, props? }` |
| `component.update`| `{ id, props }` |
| `component.destroy`| `{ id }` |
| `state.set`       | `{ scope, key, value, windowId?, ttlMs? }` (ttlMs must be positive integer) |
| `state.get`       | `{ scope, key, windowId? }` |
| `state.watch` / `state.unwatch` | same as `state.get` |
| `api.call`        | `{ method?, url, headers?, body?, idempotencyKey? }` (method defaults to "GET") |
| `txn.cancel`      | `{ id? }` |

The adapter maintains per-window DOM islands under `#workspace-root`. Commands are applied in FIFO order per window, coalesced into a single animation frame.

* `window.create` creates a draggable-ready shell with a header and content slot.
* `dom.*` operations mutate the content slot. HTML is sanitised to remove `<script>`/`<style>` tags, neutralise inline `on*` handlers, and strip `javascript:` URLs.
* `dom.set` is the preferred path for replacing the entire target subtree in one shot; `dom.append` appends sanitized HTML at the end of the target.
* `component.*` calls are mapped onto lightweight mock components so MOCK mode can emulate planner output.
* `state.*` stores values in memory to support planned future diffing. In MOCK mode watchers are inert.
* Safety net: if a `dom.*`, `component.render`, or `window.update` operation targets a `windowId` that is not present, the adapter auto-creates a shell window and persists the synthetic `window.create` so that replay on restart remains consistent.

## Interactivity via data-* attributes (no JS)

To keep planner output pure HTML, the adapter wires simple event actions via attributes:

- `data-state-scope` + `data-state-key` on `<input>`/`<textarea>` bind values into the in-memory state store on `input`/`change`.
  - Example: `<input data-state-scope="window" data-state-key="note_title">`
- `data-command` on any clickable or form element carries JSON for a batch of envelopes to enqueue on `click`/`submit`.
  - The JSON is evaluated with shallow template tokens:
    - `{{value}}` – current control value (for inputs)
    - `{{form.FIELD}}` – nearest form field by `name`
    - `{{windowId}}`, `{{componentId}}` – inferred from DOM ancestry
  - Example: `<button data-command='[{"op":"dom.set","params":{"windowId":"win","target":"#status","html":"Saved: {{form.title}}"}}]'>Save</button>`

These hooks let models build functional apps without emitting JavaScript. All generated HTML remains subject to the sanitizer.

## Budgets and Limits

The system enforces these hard limits:

- **MAX_OPS_PER_BATCH**: 64 operations per batch
- **MAX_HTML_PER_OP**: 64KB HTML per operation
- **MAX_TOTAL_HTML_PER_BATCH**: 128KB total HTML across all operations in batch
- **MAX_DATA_COMMAND_LEN**: 32KB for data-command attribute JSON
- **MAX_TEMPLATE_TOKENS**: 16 template token substitutions per element

Exceeding these limits will cause validation errors.

## `api.call` special schemes

`api.call` is side-effectful and runs best-effort on the frontend:

### Simple text intent
- `uicp://intent` with body: `{ text: string, windowId?: string }`
- Dispatches a new chat message through the app pipeline with `text`
- The bridge automatically merges it with the most recent user ask:
  `"<last user message>\n\nAdditional details: <text>"`

### Structured clarifier form
- `uicp://intent` with body: `{ textPrompt?: string, fields?: [...], title?, submit?, cancel?, windowId?, width?, height?, description? }`
- Renders an interactive form window with specified fields
- On submit, dispatches structured data back to chat pipeline
- Body MUST have `textPrompt` OR `fields` (or both)
- Body MUST NOT have `text` field (incompatible with structured format)
- Supported field types: "text", "textarea", "select"
- Field spec: `{ name: string, label: string, placeholder?: string, type?: string, options?: string[], defaultValue?: string }`

Example structured clarifier:
```json
{
  "op": "api.call",
  "params": {
    "method": "POST",
    "url": "uicp://intent",
    "body": {
      "title": "Clarify Details",
      "textPrompt": "Please provide additional information:",
      "fields": [
        { "name": "answer", "label": "Answer", "type": "text", "placeholder": "Type here..." }
      ],
      "submit": "Continue",
      "cancel": "Skip"
    }
  }
}
```

### File operations
- `tauri://fs/writeTextFile`
  - Body: `{ path: string, contents: string, directory?: "Desktop" | "Document" | ... }`
  - Writes `contents` to `path` under the given base directory (defaults to Desktop)

### HTTP requests
- `http://` or `https://`
  - Performs a `fetch` with optional JSON `body` and `headers`
  - Errors are logged; no response is surfaced to the planner

Unknown schemes are treated as no-ops (success result), preserving idempotency sequencing.

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

Planner/Actor prompts live under `src/prompts/`. The provider (`lib/llm/provider.ts`) streams completions using the Tauri-backed Ollama bridge, and the orchestrator (`lib/llm/orchestrator.ts`) parses commentary-channel JSON into validated plans/batches. An Environment Snapshot (agent flags, open windows, last trace; DOM summary by default) is prepended to prompts to increase context-awareness without leaking unsafe content.

### Aggregator

`createOllamaAggregator(onBatch?)` collects streaming deltas from the commentary channel. It accumulates text and, on flush, attempts to parse buffered JSON. When a valid batch is found:

- If `onBatch` is provided, it is called and may decide whether to auto-apply (`enqueueBatch`) or surface a preview (e.g., based on Full Control).
- If `onBatch` is not provided, the aggregator calls `enqueueBatch(batch)` by default.

The Tauri bridge installs an aggregator with a gating callback that:

- Suppresses auto-apply when the orchestrator is running (prevents duplicates) using an app-level `suppressAutoApply` flag.
- Auto-applies when Full Control is ON and not locked.
- Otherwise, sets a pending plan for preview in the chat state.

### STOP / Cancel

- The chat layer's STOP enqueues `txn.cancel` through the queue (clears pending work) and locks Full Control.
- The streaming transport supports best-effort cancellation: when the async iterator returned by `streamOllamaCompletion()` is closed, the frontend calls the Tauri command `cancel_chat(requestId)` to abort the backend HTTP request.

### Planner/Actor timeouts
- Default planner timeout: 120s; actor: 180s. Both are overridable via Vite env at build time:
  - `VITE_PLANNER_TIMEOUT_MS=120000`
  - `VITE_ACTOR_TIMEOUT_MS=180000`
The early-stop parser returns as soon as a complete JSON batch is observed, so long timeouts do not add latency when outputs finish early.

## Window Lifecycle Helpers
- `registerWindowLifecycle(listener)` subscribes to created/updated/destroyed events emitted by the adapter when windows change.
- `listWorkspaceWindows()` returns the current window ids and titles for menu initialisation.
- `closeWorkspaceWindow(id)` closes a workspace window and emits the matching lifecycle event.
