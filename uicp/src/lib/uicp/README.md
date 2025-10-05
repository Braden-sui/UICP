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
* `dom.*` operations mutate the content slot. HTML is sanitised to strip scripts, inline event handlers, and `javascript:` URLs.
* `component.*` calls are mapped onto lightweight mock components so MOCK mode can emulate planner output.
* `state.*` stores values in memory to support planned future diffing. In MOCK mode watchers are inert.

## Error surface

Validation failures raise `UICPValidationError` with:

```ts
{
  message: string;
  pointer: string; // JSON pointer describing the invalid field
  issues: z.ZodIssue[];
}
```

The chat pipeline turns these into system messages and toast notifications so that silently ignored commands never occur.
