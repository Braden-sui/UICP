# UICP Architecture Overview

## High-Level
- **Frontend:** React + Tailwind running inside a Tauri webview.
- **Backend:** Async Rust (Tokio) orchestrator handling:
  - SQLite persistence
  - Ollama Cloud API access
  - Tool/command queue
  - HTML sanitisation (ammonia)
  - File operations (exports, .env management)
- **Data Storage:** Local SQLite (`~/Documents/UICP/data.db`), `.env` for API key (MVP).
- **Models:** Kimi K2 (`kimi-k2:1t-cloud`) primary; Qwen3-Coder (`qwen3-coder:480b`) fallback post-MVP.

## Data Flow
1. **User Action:** prompts or clicks UI element.
2. **Frontend ? Backend:** invoke Tauri command (async) with input payload.
3. **Backend:**
   - Persists state to SQLite.
   - Dispatches tool commands.
   - Calls Ollama Cloud via HTTPS (OpenAI-compatible `/v1/chat/completions`).
4. **Backend ? Frontend:** emits events (`tauri::Window::emit`) streaming tool outputs, status updates, and save indicator states.
5. **Frontend:** updates React state (windows, modals, indicators), renders sanitized HTML.

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

## Ollama Cloud Integration
- Base URL: `https://ollama.com`
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

## Current Implementation Notes (2025-10-04)
- react-rnd windows persisted to SQLite; default workspace seeded if empty.
- API key stored in `~/Documents/UICP/.env` (Settings modal writes via Tauri command).
- Streaming preview shows latest chunk from `chat_completion` for debugging.

## Planned Extensions
- Tool execution queue with persistence.
- State/CRUD/`api_call` tools.
- Component library renderer.
- Export (HTML/React) + sharing.
- Linux packaging after Windows MVP.

