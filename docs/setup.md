# UICP Desktop Setup (Windows MVP)

## Prerequisites
- **Rust**: Stable toolchain via `rustup` (https://rustup.rs/)
- **Node.js**: v20.x (see `uicp/package.json` engines)
- **Tauri CLI**: ` pnpm install -g @tauri-apps/cli`
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
  - `pnpm install -g @tauri-apps/cli`
- Windows prerequisites
  - Microsoft Visual C++ Build Tools (MSVC)
  - WebView2 Runtime (usually preinstalled on Windows 11)

## Environment

Create `uicp/.env` (copy `.env.example` and edit):

```
USE_DIRECT_CLOUD=1
OLLAMA_API_KEY=your_cloud_key_here
```

Notes
- When `USE_DIRECT_CLOUD=1`, Cloud requests go to `https://ollama.com/api/chat` with `Authorization: Bearer <key>`.
- Local offload uses `http://127.0.0.1:11434/v1/chat/completions` and requires a local daemon.
 - Preferred storage for `OLLAMA_API_KEY` is the OS keyring. If you place it in `.env` for convenience, the app will read it on startup and migrate it into the keyring automatically.

### Network Guard (in-app egress)

The desktop enforces a process-level network guard that intercepts `fetch`, XHR, WebSocket, EventSource, Beacon, WebRTC, WebTransport, and Worker APIs. Defaults prioritize safety but are dev-friendly.

Defaults

- Dev builds default to monitor-only (no hard blocks) unless you override: `VITE_NET_GUARD_MONITOR=1`.
- Loopback allowed by default: `localhost`, `127.0.0.1`, `::1`.
- LAN/private ranges (RFC1918/CGNAT/link-local) are blocked unless you explicitly allow-list.
- DoH/DoT providers and metadata endpoints are blocked.
- Workers/SharedWorkers: monitor-only by default. Service Workers: blocked by default.
- WebRTC/WebTransport: monitor-only by default (log attempts; allow).

Environment (put in `uicp/.env` and rebuild):

```
VITE_NET_GUARD_ENABLED=1
VITE_NET_GUARD_MONITOR=1
VITE_GUARD_VERBOSE=0

# Allowlists (loopback is allowed by default; these are explicit)
VITE_GUARD_ALLOW_DOMAINS=localhost
VITE_GUARD_ALLOW_IPS=127.0.0.1,::1
# IPv4 CIDR ranges for labs (example)
VITE_GUARD_ALLOW_IP_RANGES=192.168.0.0/16

# Optional hard blocks (off by default except service workers)
VITE_GUARD_BLOCK_WORKERS=0
VITE_GUARD_BLOCK_SERVICE_WORKER=1
VITE_GUARD_BLOCK_WEBRTC=0
VITE_GUARD_BLOCK_WEBTRANSPORT=0
```

CSP

- `index.html` ships a CSP that restricts passive subresources and allows blob workers. Loopback is included for dev convenience:

```
default-src 'self';
connect-src 'self' https: wss: http://127.0.0.1:* http://[::1]:*;
img-src 'self' https: data: blob:;
script-src 'self';
style-src 'self' 'unsafe-inline';
font-src 'self' https: data:;
frame-src 'self';
worker-src 'self' blob:;
```

Notes

- A tiny prelude module installs the guard before the app bundle; `fetch` is locked (non-configurable, non-writable) in non-test builds to prevent unhooking by third-party scripts.

## Run

Development (webview only):

```bash
cd uicp
pnpm ci
pnpm run dev
```

Tauri dev (desktop shell):

```bash
cd uicp
pnpm ci
pnpm run tauri:dev
```

### Ports

- Dev server (Vite): `http://127.0.0.1:1420` (see `uicp/vite.config.ts`).
- Tauri dev: proxies to the same dev server on port `1420`.
- Preview (Playwright e2e): `http://127.0.0.1:4173` (see `uicp/playwright.config.ts`).

### Wasm compute (dev default)

Dev runs enable the Wasm compute runtime by default. Build and publish task components and point the app at the module directory during development:

1) Install toolchain for components

```bash
rustup target add wasm32-wasip1
cargo install cargo-component --locked
```

2) Build the components

```bash
cd uicp
pnpm run modules:build
```

3) Publish to the dev registry (copies `.wasm` to `src-tauri/modules` and updates digests)

```bash
cd uicp
pnpm run modules:publish
```

4) Run Tauri (compute runtime enabled, modules path set in dev)

```bash
cd uicp
pnpm run tauri:dev
```

Notes
- The runtime resolves modules from the app data dir by default: `~/Documents/UICP/modules`. During dev we override with `UICP_MODULES_DIR=src-tauri/modules`.
- Agent Settings shows the resolved modules directory and provides buttons to copy the path or open the folder.

## Tests

```bash
cd uicp
pnpm run lint
pnpm run typecheck
pnpm run test
# optional: pnpm run test:e2e (requires Playwright browsers and dev server)
```

CI notes
- On Linux CI, we install with `pnpm ci --ignore-scripts --no-optional` to avoid platform-specific optional binaries and postinstall hooks.
- The `postinstall` script (`uicp/scripts/postinstall.cjs`) only adjusts Rollup's native binding on Windows; running `pnpm run postinstall` on Linux/macOS is a no-op and safe.
- Markdown link checks are currently disabled in CI (docs are living; no gating).

## Quick verification

- With a valid `OLLAMA_API_KEY`, open the desktop at `http://127.0.0.1:1420` and use DockChat to trigger a simple notepad or calculator plan.
- Confirm persistence by closing/reopening: previously created windows should be restored via command replay.
