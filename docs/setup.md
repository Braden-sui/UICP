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
```

Notes
- When `USE_DIRECT_CLOUD=1`, Cloud requests go to `https://ollama.com/api/chat` with `Authorization: Bearer <key>`.
- Local offload uses `http://127.0.0.1:11434/v1/chat/completions` and requires a local daemon.
 - Preferred storage for `OLLAMA_API_KEY` is the OS keyring. If you place it in `.env` for convenience, the app will read it on startup and migrate it into the keyring automatically.

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

### Ports

- Dev server (Vite): `http://127.0.0.1:1420` (see `uicp/vite.config.ts`).
- Tauri dev: proxies to the same dev server on port `1420`.
- Preview (Playwright e2e): `http://127.0.0.1:4173` (see `uicp/playwright.config.ts`).

### Wasm compute (optional)

When you enable the `wasm_compute` feature, build and publish task components and point the app at the module directory during development:

1) Install toolchain for components

```bash
rustup target add wasm32-wasip1
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

4) Run Tauri with the compute runtime enabled (features) and the module directory set for dev

```bash
cd uicp
npm run dev:wasm:runtime
```

Notes
- The runtime resolves modules from the app data dir by default: `~/Documents/UICP/modules`. During dev we override with `UICP_MODULES_DIR=src-tauri/modules`.
- Agent Settings shows the resolved modules directory and provides buttons to copy the path or open the folder.

## Tests

```bash
cd uicp
npm run lint
npm run typecheck
npm run test
# optional: npm run test:e2e (requires Playwright browsers and dev server)
```

CI notes
- On Linux CI, we install with `npm ci --ignore-scripts --no-optional` to avoid platform-specific optional binaries and postinstall hooks.
- The `postinstall` script (`uicp/scripts/postinstall.cjs`) only adjusts Rollup's native binding on Windows; running `npm run postinstall` on Linux/macOS is a no-op and safe.
- Markdown link checks are configured via `.lychee.toml` at the repo root and run in CI.

## Quick verification

- With a valid `OLLAMA_API_KEY`, open the desktop at `http://127.0.0.1:1420` and use DockChat to trigger a simple notepad or calculator plan.
- Confirm persistence by closing/reopening: previously created windows should be restored via command replay.
