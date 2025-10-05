# UICP Architecture Overview

## High-Level
- **Frontend:** React + Tailwind running inside a Tauri webview.
- **Backend:** Async Rust (Tokio) orchestrator handling:
  - SQLite persistence
  - Ollama Cloud API access
  - Tool/command queue
  - Event streaming to the frontend (Tauri emit)
  - File operations (exports, .env management)
- **Data Storage:** Local SQLite (`~/Documents/UICP/data.db`), `.env` for API key (MVP).
- **Models:** Qwen3-Coder (`qwen3-coder:480b-cloud`) primary; local fallback uses `qwen3-coder:480b` post-MVP.

## Data Flow
1. **User Action:** prompts or clicks UI element.
2. **Frontend ↔ Backend (Tauri):**
   - Chat uses the orchestrator path by default (non-mock): planner → actor via streaming.
   - `streamOllamaCompletion()` invokes `chat_completion` with a generated `requestId`, subscribes to `ollama-completion` events, and exposes an async iterator of content/tool_call/done events.
3. **Backend (Rust):**
   - Accepts `chat_completion(request_id?, request)` and immediately spawns the streaming HTTP task keyed by `request_id`.
   - Streams Server-Sent Events from cloud/local Ollama, emitting `ollama-completion` lines and a final `{ done: true }`.
   - Supports `cancel_chat(request_id)` to abort an in-flight stream (used when the iterator is returned early on the frontend).
   - Persists workspace state to SQLite and emits save indicator deltas.
4. **Frontend (Aggregator and Queue):**
   - The Tauri bridge aggregates commentary-channel text into a buffer and, on end, tries to parse a UICP `batch`.
   - Aggregator now supports a gating callback. With Full Control ON it auto-applies via the queue; otherwise it surfaces a plan preview (pending plan). When the orchestrator is running, the bridge suppresses auto-apply/preview to avoid duplicates.
5. **Frontend (Adapter Rendering):** updates React state (windows, modals, indicators), renders sanitized HTML (client-side guardrails) under `#workspace-root` based on queued batches.

## Modules
### Rust (`uicp/src-tauri/src/main.rs`)
- `AppState`: shared state (SQLite path, HTTP client, API key cache).
- `get_paths`: exposes filesystem paths to the frontend.
- `load_api_key` / `save_api_key`: manage `.env` storage.
- `test_api_key`: validates credentials against `https://ollama.com/models` with `Authorization: <api-key>` header (no `Bearer`).
- `load_workspace` / `save_workspace`: persist draggable window layout to SQLite.
- `chat_completion`: streams Ollama Cloud responses (`ollama-completion` events).
- `enqueue_command`: placeholder for the tool queue.
- `spawn_autosave`: emits save indicator when state changes.

### Frontend (`uicp/src`)
- `App.tsx`: titlebar, save indicator, settings modal, theme toggle, window manager.
- `global.css`: base styles, dark/light themes, modal layout, stream preview styling.
- `vite.config.ts`: Vite dev server pinned to port 1420 for Tauri.
- Event listeners (`listen`) keep React state in sync with backend events.
- LLM provider/orchestrator stream commentary JSON and validate via Zod before enqueueing batches.
- Tauri bridge creates an Ollama aggregator with a gating callback to respect Full Control and orchestrator-in-flight suppression.

## Ollama Cloud Integration
- Base URL (cloud): `https://ollama.com` (no `/v1` by policy; runtime assertion enforces this)
- Base URL (local): `http://127.0.0.1:11434/v1`
- Authentication: `Authorization: <api-key>` (no `Bearer` prefix per https://docs.ollama.com/cloud#python-2)
- Endpoints:
  - `GET /models`: validate key, list models.
- `POST /chat/completions`: stream completions for tool orchestration.
- The HTTP client uses `reqwest` with Rustls TLS.

## Persistence
- SQLite schema (current): `workspace`, `window`, `window_content`, `tool_call` (width/height columns seeded on load).
- Future tables (per checklist): `app_state`, `collection`, `collection_row`, `workflow`.
- Journaling: WAL mode for resilience.

## Save Indicator Logic
- `AppState.last_save_ok` tracks status.
- Autosave loop polls every 5s and emits only on state change.
- Manual Save button calls `save_workspace` and updates the indicator immediately on success/failure.

## Current Implementation Notes (2025-10-05)
- react-rnd windows persisted to SQLite; default workspace seeded if empty.
- API key stored in `~/Documents/UICP/.env` (Settings modal writes via Tauri command).
- Streaming iterator `streamOllamaCompletion(messages, model, tools, options?)` forwards SSE lines and adds best-effort cancellation via `cancel_chat(requestId)` when the iterator is returned early. The frontend aggregator parses commentary-channel JSON into batches with a gating callback.
- Plan/Batch validation in frontend: `validatePlan`, `validateBatch` with pointer-based errors and HTML guardrails.

## Stop/Cancel Semantics
- DockChat “Stop” enqueues a `txn.cancel` batch (which clears queues promptly), locks Full Control, and posts a system message. This is separate from LLM transport cancel and is always applied locally.
- Early termination of the LLM stream (e.g., leaving the screen or canceling orchestrator flows) triggers the iterator `return()`, which calls `cancel_chat(requestId)` on the backend to abort the active HTTP stream.

## Orchestrator & Aggregator Gating
- Orchestrator path: `getPlannerClient → planWithDeepSeek → getActorClient → actWithKimi → runIntent`.
- While orchestrating, the app state sets `suppressAutoApply=true` so the aggregator does not auto-apply/preview batches arriving from the bridge.
- With Full Control ON (and not locked), aggregator auto-applies batches; otherwise, it surfaces a plan preview for user approval.

## Planned Extensions
- Tool execution queue with persistence.
- State/CRUD/`api_call` tools.
- Component library renderer.
- Export (HTML/React) + sharing.
- Linux packaging after Windows MVP.

