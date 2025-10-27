# Adapter v2: Lifecycle, DOM, Permissions

Last updated: 2025-10-26

Purpose: authoritative description of the Adapter v2 surface and internals as implemented in the UI client.

Primary modules (file paths)
- Lifecycle orchestrator: uicp/src/lib/uicp/adapters/lifecycle.ts
- Window manager: uicp/src/lib/uicp/adapters/windowManager.ts
- DOM applier: uicp/src/lib/uicp/adapters/domApplier.ts
- Component renderer: uicp/src/lib/uicp/adapters/componentRenderer.ts
- Permission gate: uicp/src/lib/uicp/adapters/permissionGate.ts
- Telemetry: uicp/src/lib/uicp/adapters/adapter.telemetry.ts

Operations (envelope `op`)
- Window: `window.create|move|resize|focus|close|update`
- DOM: `dom.set|replace|append` (sanitized HTML; deduplicated on set/replace)
- State: `state.set|get|patch|watch|unwatch`
- Components: `component.render|update|destroy`
- API: `api.call` (optionally seeds a state sink via `into`)
- Transaction: `txn.cancel`

State store and watch
- Scopes: `window|workspace|global`
- Watchers register a `selector` and optional `mode`: `replace` (default) or `append`.
- Slot-aware rendering inside the watched element (if present):
  - `data-slot="loading|empty|error|ready"`
  - When `status=loading`, only loading is shown. When `error`, error text (if any) appears in the error slot. When payload is empty, the empty slot is shown; otherwise the ready slot is shown and filled.
- `state.patch` applies a list of path ops: `merge`, `set`, `toggle`, etc., with a single render.

API `into` contract
- Before dispatch: seeds `{ status: 'loading', correlationId, data: null }` into the target key.
- On success: sets `{ status: 'ready', data: <parsed or value>, error: null }`.
- On error: sets `{ status: 'error', error: <stringifiable> }`.
- For compute responses (uicp://compute.call...), `html` may be set and is injected into the ready slot using the DOM applier.

Slot rendering example

HTML shell with slots:

```
<div id="users-shell">
  <div data-slot="loading">Loading...</div>
  <div data-slot="empty" style="display:none">No data</div>
  <div data-slot="error" style="display:none"></div>
  <div data-slot="ready" style="display:none"></div>
</div>
```

Watch + fetch with `api.into`:

```ts
await applyBatch([
  { op: 'state.watch', params: { scope: 'workspace', key: 'users', selector: '#users-shell' } },
  { op: 'api.call', params: {
      method: 'GET',
      url: 'https://example.com/api/users',
      idempotencyKey: 'load-users',
      into: { scope: 'workspace', key: 'users' }
  }},
]);
```

Behavior
- Before fetch returns: status is `loading` -> only the loading slot is visible.
- Empty data (`[]`/`{}`/`""`/null): empty slot is visible.
- Ready data: ready slot is visible and populated (sanitized HTML via DOM applier).
- Error: error slot is visible and gets the message text when available.

DOM applier rules
- All mutations sanitized (`sanitizeHtmlStrict`) unless explicitly disabled (not used in production).
- Deduplication by `windowId:target` content hash; `append` mode is never deduped.
- Modes:
  - `set` -> `innerHTML = html`
  - `replace` -> `outerHTML = html`
  - `append` -> `insertAdjacentHTML('beforeend', html)`

Permission gate
- Scopes: `window`, `dom`, `components`.
- Fast-allow: `window`, `components`.
- `dom` scope rules:
  - DOM ops require `sanitize!==false` else denied.
  - State ops (`state.set/get/patch/watch/unwatch`) are allowed.
  - `api.call` is allowed; fine-grained checks occur in adapter.api.

Workspace readiness and batching
- Batches arriving before `registerWorkspaceRoot` are queued and applied once ready.
- `resetWorkspace()` clears state stores and DOM; window close is async.

Tests
- Entry: uicp/tests/unit/adapter.lifecycle.v2.test.ts and adjacent suites under `uicp/src/lib/uicp/adapters/__tests__`.
