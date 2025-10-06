# UICP MVP - Local-First Desktop App

Update log - 2025-10-05
- Core DX Client front end added (React 18 + Tailwind + Zustand + Zod) with routes for Home and Workspace.
- Tauri event transport (Ollama SSE bridged via Tauri events) with optional Mock Mode and latency indicator.
- Inspector panel (Timeline, State, Events, Network) and Command Builder shipped.
- Desktop canvas with draggable/resizable windows and sanitized DOM roots.
- Hiding Connection Bar (Dev Mode and Mock Mode toggles).
- Windows bundle icon configured; `tauri.conf.json` points to `icons/dev_logo_icon_267632.ico`.
- Rust backend updated for Tauri 2 Emitter API and safe JSON serialization; autosave indicator stabilized.
- Ollama streaming wired: async iterator `streamOllamaCompletion(messages, model, tools, options?)` added; requestId + `cancel_chat` support; parser + cancel unit tests added.
- Tooling: Tailwind, ESLint/Prettier, Vitest unit tests, Playwright e2e skeleton.
- Event delegation at window root implemented (capture -> `ui_event`) with full support for click, input, submit, change events.
- .env.example created with USE_DIRECT_CLOUD toggle, model configuration, and Ollama endpoints.
- Runtime assertion added to reject Cloud hosts containing `/v1`.
- Rust backend updated to support USE_DIRECT_CLOUD toggle with automatic `-cloud` model suffix and host selection.
- Plan/Batch Zod validation added with unsafe HTML guardrails; snake_case accepted and normalised; pointer-based error hints wired to system messages.

## Architecture Summary
- Platform: Tauri desktop application (Windows MVP; Linux post-MVP)
- Frontend: React + Tailwind CSS with DockChat proximity dock and orchestrator phases
- Backend: Async Rust (Tokio) for filesystem, SQLite, Tauri event transport, and STOP/cancel support
- Database: SQLite (local, in ~/Documents/UICP/) with async operations
- Planner LLM: DeepSeek v3.1 (cloud native or local offload)
- Actor LLM: Qwen3-Coder:480b (cloud native or local offload)
- Cloud Host: `https://ollama.com`
- Local Host (OpenAI-compatible): `http://127.0.0.1:11434/v1`
- API Key: User provides Ollama Cloud key when `USE_DIRECT_CLOUD=1`
- Concurrency: All I/O operations async; STOP interrupts within 1s

## Philosophy
Privacy-first, local-first, async-first, user-owned data. Cloud is opt-in purely for LLM inference.

## User Flow
1. Configure `.env` with planner/actor models and cloud/local toggle.
2. Launch app, DockChat reveals on proximity or `/` hotkey.
3. Planner (DeepSeek) produces plan, Actor (Qwen3-Coder:480b) translates to batches.
4. Full Control OFF -> preview; ON -> auto-apply; STOP cancels txn.
5. Workspace state persists in SQLite; reconnect recovers cleanly.

## Technical Priorities
1. Async orchestration: planner -> actor -> validator -> adapter.
2. Safety: sanitized HTML, STOP gating, host assertions (no `/v1` on cloud).
3. Performance: minimize DOM churn; actor uses component.update diffs.
4. Observability: trace IDs, phase timings, system messages.

# MVP Checklist -  "Imagine"-style Agentic UI Builder
!!! AGENT VERIFY GROUND RULES AT EVERY PROGRESSSION OF THIS PLANNER !!!
## 0) Ground Rules (MVP) - VERIFY AT EVERY LEVEL -
- [x] Desktop-first: All data stored locally in SQLite.
- [x] Privacy-first: No cloud dependency for core features (LLM inference only).
- [x] Async-first: All I/O operations async (Rust async/await).
- [x] Persist desktop state locally; restore on launch.
- [x] User provides Ollama API key (stored in `.env`; keychain post-MVP).
- [x] Models never emit JavaScript; all UI via UICP commands.
- [x] Sanitize HTML before rendering (block script/style/on*; allowlist tags/attrs).
- [x] Apps must be stateful and persist across sessions.
- [ ] External APIs are first-class citizens.
- [x] Full Control OFF by default; modal consent required for auto-apply.
- [x] STOP cancels current txn and disables auto-apply until re-enabled.

- [x] Tauri + React + Tailwind desktop scaffold (2025-10-04)
- [x] Async Rust backend for FS/SQLite/API
- [x] Draggable/resizable windows (`react-rnd`)
- [x] Hiding Connection Bar (toggles, latency)
- [x] Sanitized HTML rendering
- [x] Event delegation at window root (capture -> `ui_event`)
- [x] Desktop layout persistence
- [x] Windows bundle icon configured

## 0.1) Env and model targets
- [x] `.env` defaults:
  - `USE_DIRECT_CLOUD=1`
  - `OLLAMA_API_KEY=` (required when `USE_DIRECT_CLOUD=1`)
  - `PLANNER_MODEL=deepseek-v3.1:671b`
  - `ACTOR_MODEL=qwen3-coder:480b`
  - `OLLAMA_CLOUD_HOST=https://ollama.com`
  - `OLLAMA_LOCAL_BASE=http://127.0.0.1:11434/v1`
- Legacy WebSocket env vars have been removed; streaming now relies on the Tauri event bridge exclusively.
- [x] Local offload (daemon) uses `*-cloud` model tags + `USE_DIRECT_CLOUD=0`.
- [x] Runtime assertion rejects any Cloud host containing `/v1` ("Do not use /v1 for Cloud. Use https://ollama.com").

## 1) Transport & Streaming
- [x] Tauri async commands & events (save indicator, API key status).
- [x] Async Rust backend handles native Ollama streaming (cloud).
- [x] Async backend handles local OpenAI-compatible streaming.
- [x] Frontend processes streamed tool commands via adapter.
- [x] Command queue with idempotency + txn cancel.
- [x] Robust error handling & retry for rate limits/timeouts.
- [x] Best-effort stream cancellation (`cancel_chat`) and STOP behaviour validated.

## 2) Planner/Actor Orchestration
- [x] Provider shim (`getPlannerClient`, `getActorClient`) selects clients and streams.
- [x] Host validation ensures `https://ollama.com` without `/v1` for cloud (Rust backend assertion in `main.rs`).
- [x] Orchestrator functions:
  - `planWithDeepSeek(intent)` -> temp 0.2, 35s timeout, 1 retry (network only), strict JSON.
  - `actWithQwen(plan)` -> temp 0.15, 35s timeout, 1 retry (network only), strict JSON.
  - `runIntent(text, applyNow)` -> planning -> acting -> validation -> preview/apply.
- [x] Fallbacks:
  - Planner invalid/timeout twice -> actor-only fallback + system message.
  - Actor invalid twice -> safe error window batch + system message (no partial apply).
- [x] Stamp `trace_id`, `txn_id`, `idempotency_key` (actor stage ensures presence).

## 3) Prompts & Validation
- [x] `src/prompts/planner.txt` (DeepSeek) -  rules: JSON only, UICP ops, create containers first, payload <=12 KB, idempotency/txn optional.
- [x] `src/prompts/actor.txt` (Qwen3-Coder:480b) -  JSON only, minimal DOM churn, ensure selectors exist, stamp ids, safe fallback on invalid plan.
- [x] `validatePlan` schema: `{ summary, risks?, batch[] }`, batch entries `{ type:"command", op, params, idempotency_key?, txn_id? }` (snake_case accepted).
- [x] `validateBatch` schema: accepts batch array with HTML sanitation and typed errors (idempotency/txn stamped later).
- [x] Validation failures produce system messages with JSON pointer + hint.

## 4) Command/Tool Execution
- [ ] Async commands bridging Rust -> frontend adapter for UICP ops (window.*, dom.*, component.*, state.*, api.call, txn.cancel).
- [x] STOP (`txn.cancel`) wired end-to-end; auto-lock auto-apply until re-enabled.

## 5) Chat UI Enhancements
- [x] DockChat proximity reveal + collapse after blur when idle.
- [x] Logs panel on desktop surfaces the conversation history (messages + system notices).
- [ ] Status line shows phases: planning -> acting -> applying (with trace ID tooltip).
- [ ] Planner summary surfaces as agent message before apply.
- [x] STOP cancels within 1s, emits message, locks auto-apply until re-consented.
- [ ] Hotkeys: `/` focus, Ctrl/Cmd+Enter send, Esc collapses when not streaming.

## 6) Mock Mode
- [ ] MOCK planner returns deterministic plans for "notepad", "todo list", "dashboard"; fallback echo window.
- [ ] MOCK actor stamps ids and ensures valid batch.
- [ ] Adapter applies normally; STOP and preview flows supported.

## 7) Observability & Logging
- [ ] Emit trace_id, plan ms, act ms, apply ms, batch size per intent.
- [ ] Structured logs redact secrets, include error codes, STOP events.
- [ ] System toasts + DockChat system messages for any errors/fallbacks.

## 8) Tests & CI
- Unit (Vitest):
  - [x] Planner JSON parse/validate (valid vs malformed).
  - [x] Batch validation rejects unsafe HTML.
  - [x] Orchestrator fallback (planner invalid twice -> actor-only).
  - [x] STOP cancels txn + locks auto-apply.
  - [x] Streaming parser extracts content/tool_calls from SSE chunks.
- E2E (Playwright):
  - [x] DockChat proximity reveal & collapse timing.
  - [x] "Make a notepad" in MOCK mode, Full Control ON -> window within 500 ms.
  - [ ] Full Control OFF -> preview then Apply updates UI.
  - [ ] Network drop/resume -> reconnection message, no crash.
- CI (`.github/workflows/ci.yml`): lint, typecheck, unit, e2e, build; fail if Cloud host uses `/v1`.

## 9) Acceptance Criteria (Updated)
- [ ] Intent "make a notepad with title and a save button" -> window visible <=1 s on Turbo; system message "Applied N commands in X ms".
- [ ] DeepSeek (planner) and Qwen3-Coder:480b (actor) invoked; DockChat shows phase statuses.
- [ ] Cloud path never uses `/v1`; local path always uses `/v1`.
- [ ] Full Control gate + STOP behave per spec (STOP cancel <=1 s).
- [ ] Planner fallback logs "Planner degraded: using Actor-only" when triggered.
- [ ] Trace IDs surfaced in system messages/logs.

## 10) Legacy Items / Backlog
- [ ] Event delegation at window root (capture -> `ui_event`).
- [ ] README with build/run instructions (done).
- [ ] First-run API key wizard.
- [ ] Performance testing (ensure UI never blocks).
- [ ] Sharing & Export (HTML/React/paste service/web viewer).
- [ ] Post-MVP roadmap: cloud sync, analytics, multi-agent coordination, etc.
- [ ] Backend command inbox for persisted tool calls (queue bridge, replay with drift detection).
- [ ] Failure handling UI (retry/discard, surfaced error metrics, toast integration).
- [ ] STOP mid-apply guard to bail out of long batches safely.
- [ ] Observability: command.dispatch/apply structured logs + metrics dashboard.

## References
- [ ] Ollama Cloud native docs: https://ollama.com/docs
- [ ] Ollama local OpenAI compatibility: https://ollama.com/blog/openai-compatibility
- [ ] DeepSeek v3.1 prompt guidance.
- [ ] Qwen3-Coder:480b usage docs.
- [ ] UICP Core README (`uicp/src/lib/uicp/README.md`).
- [ ] Playwright docs for auto-install and preview usage.

## Notes
- Planner validation failures raise typed errors; actor ensures batch safety.
- Full Control OFF by default; STOP disables auto-apply until re-consented.
- Trace IDs logged per intent for observability.
- DockChat remains the single control surface; no code shown to users.

---

## Update 2025-10-05

## 11) V1 Declaration
- [ ] All items in docs/V1 Acceptance.md satisfied (Functional, Reliability, Persistence, Performance, Observability, Security, Tests/CI).
- [ ] PR opened: "V1: Generative Desktop (Windows MVP)" linking acceptance doc and CI run.
- [ ] CI green (lint, typecheck, unit, e2e, build).
- [ ] Tag `v1.0.0` on merge and publish release notes.
- [ ] CHANGELOG.md updated with V1 section; README quickstart verified.
- [ ] Create milestone "Post‑V1: External APIs" and move remaining items.
- Transport: Frontend uses Tauri events with an Ollama aggregator; WebSocket mention is historical and slated for removal. Aggregator now supports a gating callback to auto-apply only when Full Control is ON and to suppress auto-apply during orchestrator runs.
- Orchestrator: Chat non-mock path uses `runIntent` (planner -> actor) with commentary JSON parsing hardened (fenced/noisy JSON extraction).
- Cancel/STOP: Frontend stream assigns a `requestId` and calls `cancel_chat(requestId)` when the async iterator is closed; STOP still enqueues `txn.cancel`, clears queues, and locks Full Control.
- Backend: `chat_completion` now accepts an optional `request_id` and spawns the streaming HTTP in a background task; `cancel_chat` aborts the task.
- Tests: Added unit tests for orchestrator parse, aggregator batch extraction, queue idempotency/FIFO/txn.cancel, STOP cancel flow, and iterator cancellation.
- E2E: Playwright builds with `VITE_MOCK_MODE=true` for deterministic mock flow; an optional orchestrator E2E is gated by `E2E_ORCHESTRATOR=1` and requires a real backend and API key.







