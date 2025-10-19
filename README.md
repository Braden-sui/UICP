# UICP Desktop

## Warning

- NOT PRODUCTION-READY — ACTIVE DEVELOPMENT — EXPECT BREAKING CHANGES
- Interfaces, prompts, and storage schemas are unstable and may change without notice.
- Security hardening is incomplete; do not use with sensitive data or in regulated environments.
- Data may be lost during upgrades; backups and migrations are not guaranteed.
- Windows-focused MVP; Linux/macOS support is incomplete.
 

Local‑first Tauri desktop that exposes a clean workspace canvas and a DockChat surface. DockChat is the only user control; the agent drives the UI via validated UICP Core commands. Streaming uses Tauri events.

## Vision

Build a trustworthy, local‑first generative desktop where models describe intent and the system performs safe, declarative UI updates. The agent never emits inline JS; it speaks in validated commands that the adapter applies deterministically and can replay. The compute plane executes Wasm tasks locally (capability‑scoped, feature‑gated) so common data work stays offline. Everything fails loud with typed errors, streaming is cancellable, and state changes are auditable via logs and persisted commands. Longer‑term, integrate Claude Code and the Codex CLI directly into the desktop to enable agentic coding and real code implementation with reviewable diffs and tests.

### Non‑goals for the MVP

- Production hardening and enterprise security
- Backward‑compat shims for breaking changes
- Broad OS support beyond Windows until core flows are stable

### Key runtime guardrails

- Environment Snapshot is prepended to planner/actor prompts (agent flags, open windows, last trace, and a trimmed DOM summary) to boost context-awareness.
- Models must not emit event APIs or inline JS. Interactivity is declared via `data-command` and `data-state-*` attributes only; the adapter executes these declaratively.
- Adapter auto-creates a shell window if a batch targets a missing `windowId` for `window.update`, `dom.*`, or `component.render`, and persists the synthetic `window.create` to keep replay consistent.
- Command replay preserves original creation order (no hoisting). Window closure deletes persisted commands for that window; workspace reset clears all.
- Streaming requests now enforce per-call deadlines, idempotency keys, and a per-host circuit breaker so Cloud latency or quota blips fail fast with surfaced retry hints instead of hanging the desktop.
- SQLite connections are opened with `journal_mode=WAL`, `synchronous=NORMAL`, and a 5 s busy timeout to keep concurrent replay/persist operations from starving each other.

## Quickstart

```bash
cd uicp
npm install
npm run dev            # Vite dev server (web)
# or run the desktop shell with Tauri (recommended during integration)
npm run tauri:dev
```

The dev server is configured at `http://127.0.0.1:1420` (see `uicp/vite.config.ts`). When running standalone (without Tauri), open `http://127.0.0.1:1420`.

## Project Structure

- `uicp/` — desktop app (React + Tailwind + Tauri)
  - `src/` UI, state, LLM orchestration (TypeScript)
  - `src-tauri/` Rust backend (SQLite, streaming, commands)
  - `components/` Wasm tasks (WIT + cargo-component), published into `src-tauri/modules`
  - `tests/` Vitest unit, Playwright e2e harness
- `docs/` — architecture, prompts, compute runtime docs
- `.github/workflows/` — CI for UI and compute host

## Commands

- `npm run dev` – start Vite in development mode
- `npm run tauri:dev` – start the Tauri desktop shell (proxies to Vite on port 1420)
- `npm run build` – typecheck + bundle for production
- `npm run tauri:build` – build the desktop app bundle
- `npm run lint` – ESLint over `src`
- `npm run format` – Prettier write
- `npm run typecheck` – strict TS compile
- `npm run test` – Vitest unit suite (`tests/unit`)
- `npm run test:e2e` - Playwright smoke (`tests/e2e/specs`), builds then runs preview

### Compute modules and runtime

- `npm run dev:wasm` – Tauri dev with `UICP_MODULES_DIR` on PATH for faster inner loop
- `npm run dev:wasm:runtime` – Tauri dev with compute host features (`wasm_compute,uicp_wasi_enable`)
- `npm run modules:build` – build Wasm components under `uicp/components/*`
- `npm run modules:publish` – copy built components into `uicp/src-tauri/modules` and update manifest
- `npm run gen:io` – regenerate TypeScript bindings from WIT into `uicp/src/compute/types.gen.ts`

## Documentation

- Compute runtime details: docs/compute/COMPUTE_RUNTIME_CHECKLIST.md.
- Error codes catalog: docs/error-appendix.md.
- WIL Architecture and Protocol:
  - docs/architecture.md: Planner/Actor contracts, parsing, files.
  - docs/compute/WIL.md: Quickstart + Add Op (consolidated).
- Model endpoints and auth: docs/ollama cloud vs. turbo.md.
- Docs index: docs/README.md.

## Environment

| variable | default | notes |
| --- | --- | --- |
| `VITE_DEV_MODE` | `true` | enables developer UX touches |
| `E2E_ORCHESTRATOR` | unset | set to `1` to run the orchestrator E2E (requires real backend) |
| `VITE_PLANNER_PROFILE` | `deepseek` | default planner profile (`deepseek`, `kimi`). Overridable via Agent Settings window. |
| `VITE_ACTOR_PROFILE` | `qwen` | default actor profile (`qwen`, `kimi`). Overridable via Agent Settings window. |

### Configuration & Credentials

#### API Key Storage

- Preferred: OS keyring (stored when you enter the key in-app; validated via `test_api_key`).
- Optional: `uicp/.env` for local development. On startup the backend reads `.env` (if present) and migrates `OLLAMA_API_KEY` into the keyring automatically.

#### Environment Variables

- `USE_DIRECT_CLOUD` — `1` to use Ollama Cloud, `0` for local daemon
- `OLLAMA_API_KEY` — required when `USE_DIRECT_CLOUD=1`
- `PLANNER_MODEL` — default planner model id (e.g., `deepseek-v3.1:671b`)
- `ACTOR_MODEL` — default actor model id (e.g., `qwen3-coder:480b`)
- See `.env.example` at repo root.

### Environment Snapshot

- Included by default in planner/actor prompts; no flag required. It lists agent state and open windows (with a trimmed DOM summary) to help models target updates instead of recreating UI.
- Size budget: target ~16 KB (hard cap 32 KB). Truncation rules are documented in `docs/architecture.md` (drop excess windows; no file contents; deterministic ordering).

## Agent profiles & settings

- **Planner / actor selection** – The desktop ships an *Agent Settings* utility (gear shortcut on the left rail). Switch the planner (reasoning) and actor (batch builder) between available profiles without rebuilding.
  - Planner profiles: `deepseek` (default: `deepseek-v3.1:671b`), `kimi` (default: `kimi-k2:1t`)
  - Actor profiles: `qwen` (default: `qwen3-coder:480b`), `kimi` (default: `kimi-k2:1t`)
- **Persistence** – Selections persist via Zustand storage (`uicp-app` key) and apply to the next intent immediately.
- **Cloud endpoint** – Uses Ollama Cloud native API: `POST https://ollama.com/api/chat` (SSE streaming). Local daemon uses OpenAI-compatible `/v1/chat/completions`.
- **Model IDs** – Use colon tags (e.g., `deepseek-v3.1:671b`, `qwen3-coder:480b`). Ensure your Ollama Cloud API key has access to the selected models.

## Built-in Developer Tools

UICP includes debugging and observability tools built directly into the desktop.

### Logs Panel

- **Real-time event stream** - Chat messages, backend debug events, and system telemetry
- **Event aggregation** - Streaming deltas are aggregated to reduce noise
- **Access**: Desktop shortcut or menu bar

### Metrics Panel

- **Intent telemetry** - Recent planner/actor execution with timing and status
- **Compute job summary** - Active, completed, failed, and cached job counts
- **Devtools analytics** - UI-side performance metrics
- **Access**: Desktop shortcut or menu bar

### Agent Settings

- **Model selection** - Switch planner/actor profiles (DeepSeek, Kimi, Qwen)
- **Modules info** - View WebAssembly modules directory and count
- **Cache control** - Clear workspace-scoped compute cache
- **Module verification** - Validate installed WASM modules

These tools provide visibility into the system's operation and help with debugging during development.

## Architecture

- `src/components/Desktop.tsx` – registers the `#workspace-root` canvas, exposes the desktop menu bar, and keeps the window list in sync with adapter lifecycle events.
- `src/components/DockChat.tsx` - chat surface with proximity reveal, STOP handling, and plan preview.
- `src/components/LogsPanel.tsx` - menu-controlled logs window that mirrors chat/system history for auditing.
- `src/state/app.ts` – global flags (chat open, streaming, full control) plus persisted desktop shortcuts and workspace window metadata.
- `src/state/chat.ts` – planner pipeline, plan queueing, STOP lock.
- `src/lib/uicp` - Zod schemas, DOM adapter, per-window FIFO queue with idempotency and txn.cancel, and documentation.
 

### Compute Plane

- Optional Wasm host behind Tauri feature flags (`wasm_compute`, `uicp_wasi_enable`). See `docs/compute/README.md`.
  - Workspace-scoped cache: `JobSpec.workspaceId` (default `"default"`) scopes cache keys and reads.
  - Clear Cache: Agent Settings exposes "Clear Cache" for the active workspace.
  - External APIs remain first‑class via `api.call` when a task is not suitable for local compute.

### Backend (Rust)

- Tauri 2 runtime with SQLite persistence and WAL, guarded streaming, per-request deadlines, idempotency keys, and a per-host circuit breaker.
- Compute host uses Wasmtime (WASI Preview 2) when enabled; capability-based IO; guest logs forwarded to UI debug bus.

## Testing

1. `npm run test` executes the Vitest suite covering the reveal hook, DockChat behaviour, schema validation, queue semantics, aggregator/orchestrator parse, STOP, and stream cancellation.
2. `npm run test:e2e` drives flows end-to-end in Playwright. Optional orchestrator E2E is gated by `E2E_ORCHESTRATOR=1` and requires a Tauri runtime + valid API key.

Rust (compute host)

- From `uicp/src-tauri`: `cargo test --features "wasm_compute uicp_wasi_enable" -- --nocapture`
- Build only: `cargo check --features "wasm_compute uicp_wasi_enable"`

CI

- UI: `.github/workflows/ci.yml` runs lint, typecheck, unit, e2e, build, SBOM generation, Trivy, and Gitleaks.
- Compute: `.github/workflows/compute-ci.yml` builds the Rust host, checks/pins Wasmtime, validates WIT packages, runs Rust tests, regenerates TS bindings, and executes a Playwright compute harness.
- Link checks: Markdown links are validated using Lychee with settings in `.lychee.toml`.

### CI Troubleshooting: deps install

- Use Node 20 and npm 10. The workflow sets `node-version: 20`; local failures like `npm ERR! code EBADENGINE` usually indicate a different Node version.
- Installs run with `npm ci --ignore-scripts --no-optional` to avoid platform-specific native installs. If your jobs use plain `npm install`, switch to `npm ci` with the same flags.
- Postinstall is explicitly run after install, but our script is a no-op on Linux/macOS and only restores Rollup’s Windows binding on Windows (`uicp/scripts/postinstall.cjs`). Safe to keep.
- Build/test commands are wrapped by `scripts/run-with-rollup-env.mjs`, which sets `ROLLUP_SKIP_NODE_NATIVE=true` to avoid native Rollup bindings; do not call `vite build` or `vitest` directly in CI.
- If caching issues appear, clear Actions cache for `uicp/package-lock.json` and re-run. Lockfile drift will cause `npm ci` to fail; commit the updated `package-lock.json` when dependencies change.
- Reproduce locally with: `cd uicp && npm ci --ignore-scripts --no-optional`.

## In Development

### Project status and execution plans

- Status snapshot: `docs/STATUS.md`
- Master checklist for compute runtime: `docs/compute/COMPUTE_RUNTIME_CHECKLIST.md`
- Architecture overview: `docs/architecture.md`
- MVP scope/status: `docs/MVP checklist.md`
- Coverage and recent fixes: `docs/compute/testing.md`

### Key workstreams (high level)

- Compute plane (Wasmtime, WASI Preview 2)
  - Capability gates for fs/net; stricter preopens; HTTP allowlist (scaffold)
  - Determinism probes (clock/RNG/float), epoch deadlines, memory limits
  - Module registry hardening: digest/signature verification, strict CI verify
- UI/Adapter
  - Devtools Compute Panel and Metrics Panel
  - Plan preview vs. auto‑apply gating; STOP and cancel propagation
  - Logs panel improvements with compute guest stdio previews
- Agentic coding
  - Integrate Claude Code and Codex CLI into the desktop to enable actual code implementation in a future phase
- Persistence
  - Command persistence, replay ordering and compaction
  - Workspace‑scoped compute cache with canonicalized keys
- CI and Contracts
  - WIT binding regeneration guard; component metadata checks; pinned Wasmtime

See also: `docs/INDEX.md` for onboarding and reading order.

## Requirements

- Node 20, npm 10
- Tauri CLI 2 (`@tauri-apps/cli`), Rust toolchain
- For components: `cargo-component` and `wit-component` if building Wasm modules locally

## Security

- Never commit secrets. For credentials, prefer the OS keyring. The app migrates `OLLAMA_API_KEY` from `.env` into the keyring on startup when present.
- All planner HTML is sanitized before DOM insertion.

## License

This project is licensed under the Apache License, Version 2.0. See the `LICENSE` file at the repository root for details.

