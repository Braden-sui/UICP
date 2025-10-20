# Counter Applet Example

A minimal TypeScript applet demonstrating the UICP script.panel interface.

## Architecture

**TypeScript Source** (`counter.ts`)
→ **Build Script** (`build-applet.mjs`)
→ **Bundled JS** (`counter.js`)
→ **Base64 Encoding** (by compute host)
→ **QuickJS Runtime** (`applet.quickjs@0.1.0.wasm`)
→ **Script Interface** (init/render/onEvent)

## Building

From the repo root:

```bash
node uicp/scripts/build-applet.mjs examples/counter-applet/counter.ts --out examples/counter-applet/counter.js
```

This produces a single minified JS file with the applet wrapped in an IIFE.

## Integration

### Option 1: Module-only (Rust/compiled)

For production applets, compile to a WASI component:

```json
{
  "type": "component.render",
  "params": {
    "windowId": "win-app",
    "target": "#root",
    "type": "script.panel",
    "props": {
      "id": "counter-panel",
      "module": "counter.applet@1.0.0"
    }
  }
}
```

### Option 2: JS Source (Development)

For rapid iteration with TypeScript:

```json
{
  "type": "component.render",
  "params": {
    "windowId": "win-app",
    "target": "#root",
    "type": "script.panel",
    "props": {
      "id": "counter-panel",
      "module": "applet.quickjs@0.1.0",
      "source": "<bundled-js-content>"
    }
  }
}
```

The host will:
1. Base64-encode the `source` field
2. Pass it to `applet.quickjs@0.1.0` via `UICP_SCRIPT_SOURCE_B64` env var
3. QuickJS evaluates the bundle and calls the exported functions

## Interface Contract

Your applet must export an object (default or named export) with these methods:

### `init(): string`

Returns initial state as a JSON string.

**Example:**
```ts
init() {
  return JSON.stringify({ count: 0 });
}
```

### `render(state: string): string`

Returns HTML for the current state.

**SAFETY:** All HTML is sanitized by `DomApplier` before DOM injection.

**Example:**
```ts
render(state: string) {
  const model = JSON.parse(state);
  return `<div>Count: ${model.count}</div>`;
}
```

### `onEvent(action: string, payload: string, state: string): string`

Handles UI events and returns JSON result with optional `next_state` and `batch`.

**Example:**
```ts
onEvent(action: string, payload: string, state: string) {
  const model = JSON.parse(state);
  if (action === 'increment') {
    model.count += 1;
  }
  return JSON.stringify({ next_state: JSON.stringify(model) });
}
```

## State Management

State flows through three keys (managed by adapter):

- `panels.{id}.model` (workspace) — Current model
- `panels.{id}.view` (window) — Rendered HTML sink
- `panels.{id}.config` (workspace) — Panel configuration

## Event Flow

1. User clicks button with `data-command='{"type":"script.emit","action":"increment","payload":{}}'`
2. Event delegator captures click, resolves panel ID from nearest `.uicp-script-panel` parent
3. Calls DIRECT `uicp://compute.call` with `mode: "on-event"`
4. QuickJS calls `applet.onEvent("increment", "{}", currentState)`
5. If result has `next_state`, adapter updates `panels.{id}.model`
6. Calls INTO `uicp://compute.call` with `mode: "render"` to refresh view
7. Watcher updates DOM from `panels.{id}.view`

## Constraints

- **No network:** WASI networking is disabled
- **No filesystem:** Only `ws:/files/**` readonly (if capabilities allow)
- **Memory:** Default 256 MB limit (configurable via `mem_limit_mb`)
- **Timeout:** Default 30s (configurable via `timeout_ms`)
- **Sandboxed:** All code runs in isolated WASI environment

## Testing

See `uicp/src-tauri/tests/integration_compute/quickjs_applet.rs` for integration tests.

Run tests:
```bash
cd uicp/src-tauri
cargo test --features wasm_compute,uicp_wasi_enable,compute_harness quickjs
```
