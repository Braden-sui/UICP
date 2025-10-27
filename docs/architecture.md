# Architecture (Authoritative)

See also: docs/adapter.md for Adapter v2 internals and docs/security/network-guard.md for egress policy.

Last updated: 2025-10-26

## High-Level

- Frontend: React + Tailwind running inside a Tauri 2 webview.
- Backend: Async Rust (Tokio) orchestrator handling:
  - SQLite persistence and configuration (WAL, `synchronous=NORMAL`, 5s busy timeout)
  - Ollama Cloud/local API access
  - Tool/command queue and replay
- Event streaming to the frontend (Tauri emit)
  - Optional Wasm compute plane (feature-gated)

## System Map

```
+--------------------+                    +---------------------------+
|  React UI (Vite)  |  Tauri events      |  Rust Backend (Tokio)     |
|                    |<-----------------> |                           |
|  Adapter v2        |                    |  Commands (Tauri)         |
|  - lifecycle       |                    |  - chat/compute/provider  |
|  - windowManager   |                    |  Core (paths, DB)         |
|  - domApplier      |                    |  - DATA_DIR/FILES_DIR     |
|  - permissionGate  |                    |  SQLite (WAL)             |
|  - componentRenderer|                   |  Compute (Wasmtime, gated)|
|                    |                    |  Registry/Cache/Policy    |
|  Network Guard     |                    |  Keystore + Providers     |
+--------------------+                    +---------------------------+
```
- Data Storage: Local SQLite in platform-specific data directories:
  - Linux: `~/.local/share/UICP`
  - macOS: `~/Library/Application Support/UICP`
  - Windows: `%APPDATA%\UICP` (e.g., `C:\Users\Username\AppData\Roaming\UICP`)
  - Override via `UICP_DATA_DIR` environment variable

## Backend Modules (Rust)

- `uicp/src-tauri/src/main.rs` – Tauri commands, Ollama integration, DB setup, event streaming.
- `uicp/src-tauri/src/core.rs` – shared paths (`DATA_DIR`, `FILES_DIR`), SQLite configuration (WAL, `busy_timeout`), app state.
- `uicp/src-tauri/src/commands.rs` - compute commands wired for harness/tests.
- `uicp/src-tauri/src/compute.rs` – Wasmtime host (WASI Preview 2), policy enforcement, partial/final event emission.
- `uicp/src-tauri/src/compute_cache.rs` – workspace-scoped cache with canonical keys.
- `uicp/src-tauri/src/registry.rs` – modules manifest, digest verification, install to user modules dir; `UICP_MODULES_DIR` override.
- `uicp/src-tauri/src/policy.rs` – capability checks for compute jobs.

## Commands (selected)

- Chat streaming: `chat_completion(requestId?, request)` emits `ollama-completion` events; cancel via `cancel_chat(requestId)`. Note: `requestId` is optional.
- Key management: `load_api_key`, `save_api_key`, `test_api_key` (Cloud: `GET /api/tags`, Local: `GET /v1/models`).
- Persistence: `persist_command`, `get_workspace_commands`, `clear_workspace_commands`, `delete_window_commands`.
- Compute: `compute_call`, `compute_cancel`, `clear_compute_cache` (feature-gated runtime).

## Ollama Integration

- Base URL (cloud): <https://ollama.com> (runtime rejects `/v1` to prevent drift).
- Base URL (local): <http://127.0.0.1:11434/v1>.
- Endpoints: `POST /api/chat` (stream), `GET /api/tags` (validate key), local `GET /v1/models`.
- Frontend subscribes to `ollama-completion` and parses deltas into planner/actor events.

## Event Naming

- Convention: use dashed event names (no dots) for Tauri v2 compliance.
- Backend normalizes any dotted names to dashed on emit.
- Canonical events:
  - `ollama-completion` (LLM streaming deltas and final/error)
  - `compute-result-partial` (WASI host partial frames: logs, progress, tool outputs)
  - `compute-result-final` (WASI host final payload: Ok/Err)
  - `compute-debug` (diagnostic frames from compute host/policy)
  - `save-indicator` (periodic save health ping)
  - `replay-telemetry` (replay/recovery telemetry)

## Persistence & Replay

- Commands are appended to `tool_call` and replayed in creation order on startup.
- Window close removes commands for that window; workspace reset clears all persisted commands.

## Environment Snapshot

- A compact snapshot (agent flags, open windows, last trace; DOM summary by default) is prepended to planner/actor prompts.
- No explicit size limit enforced; content is clamped per-window to 160 characters for individual text content.

## Interactivity (no inline JS)

- Planner/Actor must not emit event APIs or inline JS. Interactivity via `data-command` and `data-state-*` attributes only.
- Adapter validates and applies commands; sanitized HTML only.

## Credentials

- Embedded keystore (passphrase mode by default). Plaintext keys never leave the backend.
- UI command `save_api_key` stores a key under `uicp:ollama:api_key` and never returns it.
- No automatic migration from `.env`; legacy env import is not active.
- TTL and mode: `UICP_KEYSTORE_TTL_SEC` (default 1200), `UICP_KEYSTORE_MODE=passphrase|mock`.
- Storage location: `<app_data_dir>/keystore/keystore.db`.
- Crypto: Argon2id derives a KEK from passphrase + app salt; per-secret DEKs derived via HKDF(SHA-256); values encrypted with XChaCha20-Poly1305.

## Compute Plane (optional)

- Feature-gated host (`wasm_compute`, `uicp_wasi_enable`), registry with digest verification, workspace-scoped cache.
- Policy denies network by default; filesystem reads must be workspace-scoped (`ws:/files/**`).

## Security & Safety

- Fail loud; typed errors; structured logs; no silent drops.
- SQLite in WAL; foreign keys enabled.

### Network Guard (process-level)

- In-app egress guard wraps `fetch`, XHR, WebSocket, EventSource, Beacon, WebRTC, WebTransport, and Worker APIs.
- Defaults: loopback allowed, LAN blocked unless allow-listed, DoH providers blocked; CSP in `index.html` limits subresources.
- URLHaus integration caches malicious verdicts (host/url) and blocks WS based on cached host.
- Reference: docs/security/network-guard.md
