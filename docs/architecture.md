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
- **Models:** Qwen3-Coder (`qwen3-coder:480b-cloud`) GUI (Guy); local fallback uses `qwen3-coder:480b` post-MVP.

## Data Flow
1. **User Action:** prompts or clicks UI element.
2. **Frontend -> Backend:** `streamOllamaCompletion(messages, model, tools, { requestId })` registers a listener for `ollama-completion` events before invoking the `chat_completion` Tauri command. The iterator returns content/tool_call/done events and supports early cancellation via `cancel_chat(requestId)` when the consumer stops.
3. **Backend:**
   - Persists state to SQLite.
   - Dispatches tool commands.
   - Calls Ollama Cloud via HTTPS using `https://ollama.com` (no `/v1`).
   - Calls the local daemon using `http://127.0.0.1:11434/v1` when `USE_DIRECT_CLOUD=0`.
   - For `chat_completion`, spawns the streaming HTTP task keyed by `request_id` and emits `ollama-completion` events. `cancel_chat` aborts the task when requested.
4. **Frontend Aggregation:** the Tauri bridge accumulates commentary-channel chunks into a buffer. On completion it tries to parse a UICP batch and uses a gating callback:
   - Suppress preview/apply when the orchestrator is running (prevents duplicate apply).
   - Auto-apply via the queue when Full Control is enabled.
   - Otherwise set a pending plan preview.
5. **Frontend Rendering:** updates React state (windows, modals, indicators), renders sanitized HTML under `#workspace-root`, and exposes a Logs panel so users can review the conversation history (user / assistant / system messages with timestamps and error codes).

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
- Streaming iterator `streamOllamaCompletion(messages, model, tools, options?)` forwards SSE lines, stamps a requestId, and supports cancellation. The aggregator parses commentary-channel JSON into batches and the orchestrator stamps `traceId`, `txnId`, and `idempotencyKey` on each envelope.
- Plan/Batch validation in frontend: `validatePlan`, `validateBatch` with pointer-based errors and HTML guardrails.
- Logs panel on the desktop surfaces the conversation history (user / assistant / system messages) for quick auditing.

## Planned Extensions
- Tool execution queue with persistence.
- State/CRUD/`api_call` tools.
- Component library renderer.
- Export (HTML/React) + sharing.
- Linux packaging after Windows MVP.

