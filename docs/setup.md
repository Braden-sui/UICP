# UICP Desktop Setup (Windows MVP)

## Prerequisites
- **Rust**: Stable toolchain via `rustup` (https://rustup.rs/)
- **Node.js**: v20.x (see `uicp/package.json` engines)
- **Tauri CLI**: ` npm install -g @tauri-apps/cli`
- **Visual C++ Build Tools** (MSVC)
- **Ollama Cloud API key** from https://ollama.com

## Project Layout
```text
AI web-interface/
├─ uicp/             # React + Tailwind webview
│  └─ src-tauri/     # Async Rust backend
└─ docs/             # Documentation
```

## Install (Windows)

- Node.js 20.x
  - Recommended: https://nodejs.org/en/download (LTS 20.x)
  - Verify: `node -v` prints `v20.x.x`
- Rust toolchain
  - Install via rustup: https://rustup.rs/
  - Verify: `rustc --version`
- Tauri CLI
  - `npm install -g @tauri-apps/cli`
- Windows prerequisites
  - Microsoft Visual C++ Build Tools (MSVC)
  - WebView2 Runtime (usually preinstalled on Windows 11)

## Environment

Create `uicp/.env` (copy `.env.example` and edit):

```
USE_DIRECT_CLOUD=1
OLLAMA_API_KEY=your_cloud_key_here
PLANNER_MODEL=deepseek-v3.1:671b
ACTOR_MODEL=qwen3-coder:480b
VITE_MOCK_MODE=true
```

Notes
- When `USE_DIRECT_CLOUD=1`, Cloud requests go to `https://ollama.com/api/chat` with `Authorization: Bearer <key>`.
- Local offload uses `http://127.0.0.1:11434/v1/chat/completions` and requires a local daemon.

## Run

Development (webview only):

```bash
cd uicp
npm ci
npm run dev
```

Tauri dev (desktop shell):

```bash
cd uicp
npm ci
npm run tauri:dev
```

### Wasm compute (optional, now default-enabled)

If you enabled the `wasm_compute` feature (default in this repo), you need to build and publish the task components and point the app at the module directory during development:

1) Install toolchain for components

```bash
rustup target add wasm32-wasi
cargo install cargo-component --locked
```

2) Build the components

```bash
cd uicp
npm run modules:build
```

3) Publish to the dev registry (copies `.wasm` to `src-tauri/modules` and updates digests)

```bash
cd uicp
npm run modules:publish
```

4) Run Tauri with the module directory set for dev

```bash
cd uicp
npm run dev:wasm
```

Notes
- The runtime resolves modules from the app data dir by default: `~/Documents/UICP/modules`. During dev we override with `UICP_MODULES_DIR=src-tauri/modules`.
- To switch back to the non-Wasm placeholder path without removing the feature, set `UICP_COMPUTE_TYPED_ONLY=0`.

## Tests

```bash
cd uicp
npm run lint
npm run typecheck
npm run test
# optional: npm run test:e2e (requires Playwright browsers and dev server)
```

## Quick verification

- With `VITE_MOCK_MODE=true`, open the desktop at `http://127.0.0.1:1420` and use DockChat to trigger a simple notepad or calculator plan.
- With a valid `OLLAMA_API_KEY`, disable MOCK mode to exercise real planner/actor streaming via Cloud.
- Confirm persistence by closing/reopening: previously created windows should be restored via command replay.
