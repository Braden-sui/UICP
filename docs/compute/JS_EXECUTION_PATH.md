# Track E: JavaScript Execution Path in WASI

## Overview

UICP supports executing JavaScript code via the `applet.quickjs@0.1.0` WASI component, enabling rapid development of interactive UI panels without recompiling Rust code. The JS runtime is sandboxed with no network, limited filesystem access, and enforced memory/time limits.

## Architecture

```
TypeScript Source
    ↓ (build-applet.mjs)
Bundled JS String
    ↓ (compute host)
Base64 Encode → UICP_SCRIPT_SOURCE_B64 env var
    ↓ (WASI component)
applet.quickjs@0.1.0.wasm (Boa engine)
    ↓ (WIT interface)
uicp:applet-script@0.1.0 (init/render/onEvent)
    ↓ (adapter)
script.panel lifecycle
```

## Components

### 1. WASI Component: `applet.quickjs@0.1.0`

**Location:** `uicp/components/applet.quickjs/`

**Runtime:** Boa JavaScript engine (ES2020 target)

**Imports:** None (fully sandboxed)

**Exports:** `uicp:applet-script@0.1.0/script`
- `init() -> result<string, string>`
- `render(state: string) -> result<string, string>`
- `on-event(action: string, payload: string, state: string) -> result<string, string>`

**Source Injection:** JS code is passed via `UICP_SCRIPT_SOURCE_B64` environment variable (base64-encoded).

**Error Codes:**
- `E-UICP-0600`: Failed to construct JS context
- `E-UICP-0601`: Evaluating bundled script failed
- `E-UICP-0602`: Calling applet function failed
- `E-UICP-0603`: Stringify JS result failed
- `E-UICP-0604`: Missing bundled JS source (validation error)

### 2. Build Script: `build-applet.mjs`

**Location:** `uicp/scripts/build-applet.mjs`

**Purpose:** Compile TypeScript to a single minified JS bundle

**Usage:**
```bash
node uicp/scripts/build-applet.mjs entry.ts --out bundle.js
node uicp/scripts/build-applet.mjs entry.ts --print-json  # For embedding in JSON
```

**Output Format:**
```javascript
(() => {
  const exports = {};
  const module = { exports };
  // ... bundled code ...
  const applet = module.exports?.default ?? module.exports;
  if (!applet || typeof applet !== 'object') {
    throw new Error('Applet bundle must export an object.');
  }
  globalThis.__uicpApplet = applet;
})();
```

**Features:**
- esbuild bundling (ES2020, CJS format)
- Minification enabled
- U+2028/U+2029 sanitization (line/paragraph separators)
- Exports to `globalThis.__uicpApplet`

### 3. Compute Host Integration

**Source Detection:** `compute_input.rs::extract_script_input()`
- Extracts `input.source` field from job spec
- Validates mode: `init` | `render` | `on-event`

**Base64 Encoding:** `compute.rs` (lines 1200-1204)
```rust
if let Some(source) = script_input.source.as_ref() {
    let encoded = BASE64_ENGINE.encode(source.as_bytes());
    wasi_builder.env(SCRIPT_SOURCE_ENV, &encoded);
}
```

**Task Routing:** `compute.rs` (lines 1409-1431)
- Routes `applet.quickjs` to script world bindings
- Enforces source presence (E-UICP-0604)
- Calls init/render/onEvent based on mode

### 4. Frontend: script.panel Lifecycle

**Component Registration:** `componentRenderer.ts`
```typescript
register('script.panel', (params) => {
  const props = asRecord(params.props);
  const panelId = typeof props.id === 'string' && props.id.trim() 
    ? props.id 
    : createId('panel');
  const attrs = `class="uicp-script-panel" data-script-panel-id="${panelId}"`;
  return `<div ${attrs}></div>`;
});
```

**State Keys:**
- `panels.{id}.model` (workspace) — Current model JSON
- `panels.{id}.view` (window) — Rendered HTML sink
- `panels.{id}.config` (workspace) — Panel configuration

**Event Flow:**
1. User clicks button with `data-command='{"type":"script.emit","action":"...","payload":{}}'`
2. Event delegator (`adapter.events.ts`) resolves panel ID from `.uicp-script-panel` ancestor
3. Calls DIRECT `uicp://compute.call` with:
   ```json
   {
     "task": "applet.quickjs@0.1.0",
     "input": {
       "mode": "on-event",
       "action": "increment",
       "payload": "{}",
       "state": "<current model>",
       "source": "<bundled js>"
     }
   }
   ```
4. Returns `{ "data": { "next_state": "...", "batch": [...] } }`
5. Adapter updates `panels.{id}.model` if `next_state` present
6. Calls INTO `uicp://compute.call` with `mode: "render"` to refresh view

## Two Modes

### Module-Only Mode (Production)

For production applets, compile to a dedicated WASI component:

```json
{
  "type": "component.render",
  "params": {
    "type": "script.panel",
    "props": {
      "id": "my-panel",
      "module": "my.custom.applet@1.0.0"
    }
  }
}
```

**Benefits:**
- Smaller bundle size (no JS runtime overhead)
- Faster startup (native Wasm)
- Statically verified (WIT contracts)

### JS Source Mode (Development)

For rapid iteration during development:

```json
{
  "type": "component.render",
  "params": {
    "type": "script.panel",
    "props": {
      "id": "my-panel",
      "module": "applet.quickjs@0.1.0",
      "source": "<bundled-js-string>"
    }
  }
}
```

**Benefits:**
- No compilation step (edit TS, bundle, reload)
- Faster iteration cycle
- Full TypeScript tooling

## Contract

Your applet must export an object (default or named export) with:

### `init(): string`

Returns initial state as JSON string.

**Example:**
```typescript
init() {
  return JSON.stringify({ count: 0 });
}
```

### `render(state: string): string`

Returns HTML for the current state. All HTML is sanitized by `DomApplier` before DOM injection.

**Example:**
```typescript
render(state: string) {
  const model = JSON.parse(state || '{}');
  return `<div>Count: ${model.count}</div>`;
}
```

### `onEvent(action: string, payload: string, state: string): string`

Handles UI events and returns JSON result.

**Result Shape:**
```typescript
interface OnEventResult {
  next_state?: string;  // Updated model JSON
  batch?: unknown[];    // Optional UICP commands
}
```

**Example:**
```typescript
onEvent(action: string, payload: string, state: string) {
  const model = JSON.parse(state || '{}');
  if (action === 'increment') {
    model.count += 1;
  }
  return JSON.stringify({ 
    next_state: JSON.stringify(model) 
  });
}
```

## Safety & Constraints

### Sandboxing

- **No network:** WASI networking disabled
- **No filesystem:** Only `ws:/files/**` readonly (if capabilities grant)
- **No random:** No WASI random (deterministic)
- **No wall clock:** Monotonic clock only

### Resource Limits

- **Memory:** Default 256 MB, configurable via `mem_limit_mb`
- **Timeout:** Default 30s, configurable via `timeout_ms`
- **Fuel:** Optional deterministic execution budget
- **Log bytes:** Max 256 KB total stdout/stderr per job

### Isolation

- Each job runs in fresh WASI instance
- No state persists between jobs
- No access to host filesystem outside preopens
- All HTML sanitized before DOM injection

## Example: Counter Applet

See `examples/counter-applet/` for a complete TypeScript example.

**Build:**
```bash
node uicp/scripts/build-applet.mjs examples/counter-applet/counter.ts \
  --out examples/counter-applet/counter.js
```

**Features:**
- Increment/decrement/reset actions
- State management (count persistence)
- Inline styles
- Event handlers via `data-command`

## Testing

### Integration Tests

**Location:** `uicp/src-tauri/tests/integration_compute/quickjs_applet.rs`

**Run:**
```bash
cd uicp/src-tauri
cargo test --features wasm_compute,uicp_wasi_enable,compute_harness quickjs
```

**Coverage:**
- ✅ Module preflight (component model validation)
- ✅ `init()` returns valid JSON state
- ✅ `render()` produces HTML with embedded count
- ✅ `onEvent()` updates state correctly
- ✅ Missing source validation (E-UICP-0604)

### Unit Tests

Component-level tests in `uicp/components/applet.quickjs/src/lib.rs` validate:
- Base64 decoding from env var
- Boa context creation
- Function invocation
- Error code paths

## Debugging

### Enable Compute Logs

```bash
UICP_WASI_DIAG=1 npm run dev:wasm
```

This emits:
- Component imports/exports at job start
- Partial log frames with base64 previews
- Throttle/rate-limit metrics

### Check Module Manifest

```bash
cat uicp/src-tauri/modules/manifest.json | grep -A 7 "applet.quickjs"
```

Expected:
```json
{
  "task": "applet.quickjs",
  "version": "0.1.0",
  "filename": "applet.quickjs@0.1.0.wasm",
  "digest_sha256": "<64-hex-chars>",
  "signature": "<base64>",
  "keyid": "dev-seed"
}
```

### Verify Component

```bash
cd uicp/components/applet.quickjs
cargo component build --release
wasm-tools validate target/wasm32-wasip1/release/applet_quickjs.wasm
```

## Migration Path

1. **Prototype** in JS via `applet.quickjs@0.1.0`
2. **Stabilize** API and state shape
3. **Benchmark** if performance matters
4. **Compile** to Rust WASI component if needed
5. **Deploy** as dedicated module (e.g., `my.app@1.0.0`)

For most interactive panels, JS performance is sufficient. Only migrate to Rust for:
- Compute-heavy operations (data processing, parsing)
- Large state (> 1 MB)
- Tight latency requirements (< 10ms render)

## References

- **WIT Interface:** `uicp/src-tauri/wit/script.world.wit`
- **Component Source:** `uicp/components/applet.quickjs/src/lib.rs`
- **Build Script:** `uicp/scripts/build-applet.mjs`
- **Integration Tests:** `uicp/src-tauri/tests/integration_compute/quickjs_applet.rs`
- **Example Applet:** `examples/counter-applet/`
- **Compute README:** `docs/compute/README.md`
