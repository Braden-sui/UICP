# UICP MVP - Local-First Desktop App

Update log — 2025-10-04
- Core DX Client front end added (React 18 + Tailwind + Zustand + Zod) with routes for Home and Workspace.
- WebSocket transport (hello/resume) with optional Mock Mode and latency indicator.
- Inspector panel (Timeline, State, Events, Network) and Command Builder shipped.
- Desktop canvas with draggable/resizable windows and sanitized DOM roots.
- Hiding Connection Bar (hover to reveal on connect) with WS URL, Connect/Disconnect, Dev Mode and Mock Mode toggles.
- Windows bundle icon configured; `tauri.conf.json` points to `icons/dev_logo_icon_267632.ico`.
- Rust backend updated for Tauri 2 Emitter API and safe JSON path serialization; autosave indicator stabilized.
- Tooling: Tailwind, ESLint/Prettier, Vitest unit tests, Playwright e2e skeleton.

## Architecture Summary
- Platform: Tauri desktop application (Windows MVP; Linux post-MVP)
- Frontend: React + Tailwind CSS
- Backend: Async Rust with Tokio runtime
- Database: SQLite (local, in ~/Documents/UICP/) with async operations
- Model Provider: Ollama (ollama.com)
- Model: Kimi K2 (1T params, via Ollama Cloud API)
- API Endpoint: https://ollama.com
- API Format: OpenAI-compatible streaming with async tool calling
- Hosting: None required for MVP (local-first)
- Sharing: Export to HTML/React, paste service links (async operations)
- API Key: User provides their own Ollama API key (stored in `.env` for MVP)
- Concurrency: All I/O operations are asynchronous (non-blocking)

## Philosophy
Privacy-first, local-first, async-first, user-owns-their-data. Cloud sync is optional.

## User Flow
1. Download and install Tauri app
2. On first launch: Enter Ollama API key (async validation)
3. Start building: Talk to K2, watch apps appear (non-blocking)
4. All data stays local in SQLite (async persistence)
5. Optional: Share/export creations (async operations)

## Technical Priorities
1. Async Everything: No blocking operations — UI always responsive
2. Local-First: All data on user's machine
3. Privacy: No cloud dependency for core features
4. Performance: Fast startup, instant saves, smooth interactions

# MVP Checklist — "Imagine"-style Agentic UI Builder

## 0) Ground Rules (MVP)
- [ ] Desktop-first: All data stored locally in SQLite
- [ ] Privacy-first: No cloud dependency for core features (only model API calls)
- [ ] Async-first: All I/O operations must be asynchronous (Rust async/await)
- [ ] Persist desktop state locally; restore on app launch
- [ ] User provides their own Ollama API key (stored in `.env`; keychain post-MVP)
- [ ] Model must not emit JavaScript. All UI changes via tools/commands only.
- [ ] Sanitize any HTML before rendering (block script/style/on* handlers; allowlist tags/attrs).
- [ ] Apps must be stateful (not just ephemeral demos).
- [ ] Data persists across sessions.
- [ ] External APIs are first-class citizens.

- [x] Tauri + React + Tailwind desktop app scaffold (2025-10-04)
- [x] Async Rust backend bootstrapped for file system, SQLite, and API calls
- [x] Draggable/resizable windows with `react-rnd`
- [x] Hiding Connection Bar (WS URL, Connect/Disconnect, Dev/Mock, latency)
- [x] Content pane renders sanitized HTML (client-side sanitizer)
- [ ] Event delegation at window root: capture `click|input|submit|change` with `id`/`data-*` and send as `ui_event`.
- [x] Desktop layout persistence to local SQLite (manual save + load on launch)
- [x] Windows bundle icon configured

## 2) Transport & Streaming (MVP)
- [x] Tauri async commands (invoke backend from frontend) for configuration & save indicator
- [x] Tauri events (backend emits `save-indicator`, `api-key-status`; frontend listens)
- [ ] Async Rust backend handles Ollama API streaming (pending)
- [ ] Frontend receives streamed tool commands (pending)
- [x] Baseline `chat_completion` command streams Ollama deltas (`ollama-completion` event) — tool orchestration pending
- [ ] Command queue in async Rust with idempotency (pending)
- [ ] Handle Ollama API errors (rate limits, timeouts) with async retry logic (pending)

## 3) Command/Tool Schema (Model → Frontend)
- [ ] Implement tools as async Tauri commands that forward to the client executor:
  - [ ] `window_new`: `{ id, title, size: "xs|sm|md|lg|xl", x?: number, y?: number }`
  - [ ] `dom_replace_html`: `{ selector, html, sanitize?: boolean }`
  - [ ] `init_tool`: `{ tool: "chart_js|mermaid|leaflet", options?: {} }`
  - [ ] `chart_render`: `{ target, library: "chart_js", spec: object }`
  - [ ] `mermaid_render`: `{ target, definition: string }`
  - [ ] `map_show`: `{ target, center: [lat, lng], zoom?: number, markers?: [] }`
  - [ ] `notify`: `{ level: "info|warn|error", message: string }` (optional)
  - [ ] `focus_window`: `{ id }` / `close_window`: `{ id }` (optional)
  - [ ] `web_search`: `{ query: string, k?: number }` (backend-only; returns results to model) [post‑MVP]
  - [ ] `set_state`: `{ window_id, key, value, scope: "window|workspace|global" }`
  - [ ] `get_state`: `{ window_id?: string, keys: string[] }` → returns state
  - [ ] `subscribe_state`: `{ window_id: string, keys: string[], on_change: string /* callback id */ }`
  - [ ] `db_query`: `{ collection: string, filter?: object, limit?: number }`
  - [ ] `db_insert`: `{ collection: string, data: object }`
  - [ ] `db_update`: `{ collection: string, filter: object, data: object }`
  - [ ] `db_delete`: `{ collection: string, filter: object }`
  - [ ] `api_call`: `{ method: "GET|POST|PUT|DELETE", url: string, headers?: object, body?: object, auth?: { type: "bearer|basic|oauth", credentials: string /* key id */ } }`
  - [ ] `render_component`: `{ component: string /* table|form|card|timeline|kanban|... */, target: string, props: object }`
  - [ ] `watch_collection`: `{ collection: string, filter?: object, callback: string /* agent/callback id */ }`
  - [ ] `poll_api`: `{ url: string, interval_ms: number, callback: string }`
  - [ ] `watch_file`: `{ path: string, callback: string }` (local-first)
  - [ ] `create_workflow`: `{ id: string, trigger: { type: "schedule|webhook|event", config: object }, steps: [{ tool: string, args: object }] }`
  - [ ] `run_workflow`: `{ id: string, input?: object }`
- [ ] JSON Schema validation + error surface back to model.
- [ ] DSL fallback (strict line-based) for non-tool models (post‑MVP if needed).

- [x] Ollama API client foundation (reqwest, async) with `/v1/models` validation
- [ ] Implement `/v1/chat/completions` streaming pipeline
- [x] Endpoint baseline: https://ollama.com
- [x] Model identifier confirmed: "kimi-k2:1t" (via live API)
- [x] System prompt reference in `docs/prompts/gui.md`
- [ ] Streaming parse loop (function-call/tool execution) pending
- [x] Authentication header: `Authorization: <api-key>` (no `Bearer` prefix)
- [ ] Retry/repair loop & error handling (rate limits, availability)
- [ ] Optional fallback: `qwen3-coder:480b-cloud`

- [x] Async Rust backend in Tauri (`uicp/src-tauri/`)
- [x] Tokio runtime configured via `tauri::Builder`
- [x] Async command handlers (`get_paths`, `load_api_key`, `save_api_key`, `test_api_key`, `enqueue_command` placeholder)
- [x] Event emitters for save indicator / API key status
- [ ] Async command queue persisted to SQLite (todo)
- [x] Non-blocking execution (commands spawn via Tokio)
- [x] Ammonia sanitizer dependency in place (integration pending)
- [ ] Optional async `web_search`
- [ ] Structured logging to file (todo)
- [ ] Log Ollama API interactions (todo)

- [x] SQLite location `~/Documents/UICP/data.db`
- [x] Async-enabled connection (tokio + rusqlite)
- [ ] Migration wiring via refinery (current manual schema)
- [ ] Workspace/window persistence (placeholder schema only)
- [ ] Autosave diffing & flush (indicator toggles but no real writes)
- [ ] rusqlite + SQLite at `~/Documents/UICP/data.db`
- [ ] Async SQLite using `tokio-rusqlite` or similar
- [ ] SQLite accessed only from Rust backend (not directly from React)
- [ ] Migrations managed by Rust (refinery or rusqlite_migration):
  - [ ] `User(id, email, password_hash, created_at)` — single hardcoded user for MVP (no auth)
  - [ ] `Project(id, user_id, name, created_at, last_opened_at)` — user_id can be constant
  - [ ] `Workspace(id, project_id, name, status, created_at)`
  - [ ] `Window(id, workspace_id, title, size, x, y, z, created_at, updated_at)`
  - [ ] `WindowContent(id, window_id, html, version, created_at)` (latest per window)
  - [ ] `Artifact(id, window_id, type:"web|md|diagram", meta_json)`
  - [ ] `ChatMessage(id, workspace_id, role, content, created_at)` — standard format (no special channels)
  - [ ] `ToolCall(id, workspace_id, tool, args_json, result_json, created_at)`
  - [ ] `APIConfig(id, provider:"ollama", api_key_encrypted, created_at)` — store encrypted Ollama API key
- [ ] Async load last workspace on app launch
- [ ] Async auto-save to SQLite every 5 seconds (background task)

## 6b) Persistence (Enhanced Platform)
- [ ] `AppState(workspace_id, scope, key, value_json, updated_at)`
- [ ] `Collection(id, workspace_id, name, schema_json, created_at)`
- [ ] `CollectionRow(id, collection_id, data_json, created_at, updated_at)`
- [ ] `APIKey(id, user_id, service, key_id, secret_encrypted, created_at)`
- [ ] `Workflow(id, workspace_id, trigger_json, steps_json, created_at, updated_at)`

## 7) Auth & Sessions (MVP)
- [ ] NO AUTH for MVP (single-user desktop app)
- [ ] Optional: Multi-workspace support (no user accounts)
- [ ] Store Ollama API key in OS keychain (keyring crate)
- [ ] Async keychain operations (non-blocking)
- [ ] Settings UI for entering/updating API key
- [ ] Async API key validation on first use (test call)

## 8) Desktop App Features (Tauri-Specific) (MVP)
- [x] App window: frameless (decorations=false); in-app controls to re-add in Core shell
- [ ] Menu bar: File, Edit, View, Window, Help
- [ ] File menu: New/Open/Save/Export HTML/Export React/Settings/Quit
- [ ] Settings dialog: API key input, async validation, model selection, temperature
- [ ] Keyboard shortcuts (Cmd/Ctrl + N, S, O, Q, comma for settings)
- [x] App icon and branding (Windows .ico wired)

## 11b) Core DX Client (Profile: Core only)
- [x] WebSocket transport (hello/resume) with Network view
- [x] Hiding Connection Bar with Dev/Mock toggles and latency pill
- [x] Inspector tabs (Timeline/State/Events/Network)
- [x] Command Builder with Zod validation for Core ops
- [x] Mock mode: echo acks + fake REST for `/todos`
- [x] Canvas windows + sanitized DOM root
- [ ] Wire builder “Send” to transport + Core op execution on canvas
- [ ] Demo Todos: optimistic insert + ack settle via mock `api.call`
- [ ] Auto-updater (tauri-plugin-updater)
- [ ] System tray icon (optional, background mode)
- [ ] Native file picker for opening/saving workspaces
- [ ] Drag-and-drop files onto app window
- [ ] First-run experience (welcome screen, API key setup)
- [ ] Non-blocking UI (all long operations run async)

## 9) Integrations (MVP)
- [ ] Chart.js via CDN in webview, called from React; `chart_render` idempotent
- [ ] Mermaid via CDN in webview
- [ ] Leaflet via CDN (offline-capable with cached tiles)
- [ ] Tailwind via CDN (or compile custom build)

## 10) Sharing & Export (MVP)
- [ ] Export workspace as standalone HTML (async file writing)
- [ ] Bundle all window HTML into single file; include inline Tailwind; embed state JSON; read-only mode
- [ ] Share via paste service (paste.ee or GitHub Gist): async upload JSON; generate link; copy to clipboard; notify
- [ ] Export as React app: async generate project files (Next.js), package.json, README; zip and save
- [ ] Minimal web viewer (static on Vercel): fetch shared workspace JSON; render read-only; landing page with CTA

## 10b) Testing & QA (MVP)
- [ ] Unit: command validator, DSL parser (if used), sanitizer.
- [ ] Integration: mock model → command sequence → window DOM assertions.
- [ ] E2E happy path: “Create dashboard → init chart → render → click updates → persist/reload.”
- [ ] Regression script: replay stored traces; confirm deterministic DOM.
- [ ] K2 stress tests: multi-window (≥5 windows), cross-window interactions, ensure state tracking across updates.
- [ ] Failure recovery: inject renderer failures (e.g., `chart_render`) and assert fallbacks or safe retries.

## 11) Developer Experience (MVP)
- [ ] Scripts: `tauri dev`, `tauri build`, `lint`.
- [ ] README quick start (Rust toolchain + Tauri setup).
- [ ] Sample seed: creates a project and demo window.
- [ ] Settings UI for API key; show K2 token usage per request in dev mode.
- [ ] Optional A/B: compare K2 vs smaller models for cost/latency.

## 12) Milestones & Acceptance
Milestone 0 — Tauri Setup (1 day) [NEW]
- [ ] Install Tauri CLI and Rust toolchain
- [ ] Create Tauri project: `npm create tauri-app`
- [ ] Verify build works: `npm run tauri dev`
- [ ] Add Cargo dependencies: rusqlite, tokio, reqwest (stream), keyring, ammonia, serde/serde_json
- [ ] Basic "Hello World" window displays

Milestone 1 — Shell & Transport (2 days)
- [ ] React frontend in Tauri webview
- [ ] Async SQLite connection from Rust
- [ ] Draggable windows (react-rnd)
- [ ] Tauri async commands (frontend ↔ backend)
- [ ] HTML sanitizer (ammonia)
- [ ] Settings UI for API key input
- [ ] Async store API key in OS keychain

Milestone 2 — Tools & Renderers (2 days)
- [ ] `window_new`, `dom_replace_html`, `init_tool`, `chart_render`, `mermaid_render`, `map_show` as async Tauri commands
- [ ] Async command execution queue
- [ ] Async persist commands to SQLite

Milestone 3 — Model Adapter (1.5–2 days)
- [ ] Async Ollama API client in Rust (reqwest with async)
- [ ] Endpoint: https://ollama.com
- [ ] Model: "kimi-k2" (verify identifier)
- [ ] Async streaming responses from Ollama
- [ ] Tool call parsing (OpenAI-compatible)
- [ ] System prompt for K2 (tools-only, no JS)
- [ ] Async validator/repair loop for invalid tool calls
- [ ] Error handling (rate limits, API errors, network issues)
- [ ] Non-blocking: UI stays responsive during long completions

Milestone 4 — Persistence & API Key Management (1 day)
- [ ] SQLite migrations (refinery)
- [ ] Async load last workspace on launch
- [ ] Async auto-save every 5 seconds (Tokio background task)
- [ ] NO AUTH (single-user app)
- [ ] Async Ollama API key retrieval from keychain
- [ ] Settings UI to update/test API key (async validation)

Milestone 5 — QA & Polish (1 day)
- [ ] Manual testing checklist
- [ ] Error handling (user-friendly messages)
- [ ] App icon and branding
- [ ] README with build/run instructions
- [ ] First-run experience (API key setup wizard)
- [ ] Performance testing (ensure UI never blocks)

Milestone 6 — Sharing & Export (1 day) [NEW]
- [ ] Async export to HTML
- [ ] Async export to React app (zip)
- [ ] Async share via paste service
- [ ] Copy link functionality
- [ ] Basic web viewer (deploy to Vercel)

Acceptance Criteria
- [ ] Given: user launches app, enters Ollama API key, prompts "Create a sales dashboard with a bar chart and a map."
- [ ] Then: K2 (via Ollama) issues tool calls; async Rust backend executes; React frontend shows window with chart/map
- [ ] And: UI remains responsive during K2 completion (can drag windows, type, etc.)
- [ ] And: clicking a filter button sends event to Rust → Ollama (K2) → updates chart (async)
- [ ] And: closing app and reopening restores workspace from SQLite (async load)
- [ ] And: user can export workspace as HTML file (async, non-blocking)
- [ ] And: user can generate share link that works in web viewer (async upload)
- [ ] And: API key is securely stored in OS keychain (not in plaintext)
- [ ] And: all file I/O and network operations complete without freezing UI

## 13) Post‑MVP (Soon After)
- [ ] Web viewer already in MVP (static site); add "Remix" button (downloads app with workspace)
- [ ] Sub‑agent routing per window (`spawn_subagent`) with async Rust
- [ ] Optional: Evaluate containerized runner if needed (Tauri already sandboxed)
- [ ] Cloud Sync (optional paid tier):
  - [ ] End-to-end encrypted backup to cloud (async)
  - [ ] Cross-device sync (desktop ↔ laptop)
  - [ ] Real-time collaboration (multi-user workspace)
  - [ ] PostgreSQL for sync log only (not primary storage)
  - [ ] Stripe integration for $5/mo Pro tier
- [ ] Local analytics only (no tracking to servers); usage stats in app
- [ ] Multiple model support: switch among Ollama models, direct Moonshot, Claude/GPT-4 via user API keys
- [ ] Agent pool: `spawn_agent`, `message_agent`, `kill_agent` for background/window-scoped agents
- [ ] Workflow engine: schedule/webhook/event triggers; action chaining
- [ ] Live watchers: `watch_collection`, `poll_api`, `watch_file` driving UI updates

## 14) References
- [ ] Ollama API docs: ollama.com/cloud
- [ ] Ollama OpenAI compatibility: https://ollama.com/blog/openai-compatibility
- [ ] Kimi K2 on Ollama: verify model identifier and parameters in Ollama library
- [ ] Tauri documentation: https://tauri.app/
- [ ] Tokio async runtime: https://tokio.rs/
- [ ] reqwest async HTTP: https://docs.rs/reqwest/
- [ ] rusqlite: https://docs.rs/rusqlite/
- [ ] keyring crate: https://docs.rs/keyring/
- [ ] Tauri async commands: https://tauri.app/v1/guides/features/command/

## 15) “Anything App” Validation
- [ ] Todo App: CRUD + filters; persists across sessions.
- [ ] Dashboard: external API + multiple charts; auto-refresh every 30s.
- [ ] Form Builder: multi-step with validation; draft save/restore.
- [ ] Mini CRM: contacts/companies with relationships and search.
- [ ] Workflow Automation: triggers + actions chaining.

## 16) Platform Track Timeline
- Phase 1 — State & Data
  - [ ] Day 8–9: State management (`set_state`/`get_state`).
  - [ ] Day 10–11: JSONStore CRUD (`db_*`).
  - [ ] Day 12: Reactive updates (`watch_collection`).
- Phase 2 — Components
  - [ ] Day 13–15: Build 5 core components (table, form, card, list, chart-wrapper).
  - [ ] Day 16–17: Component registry + `render_component` tool.
- Phase 3 — Integration
  - [ ] Day 18–19: API gateway (`api_call`).
  - [ ] Day 20: OAuth flow for common services.
  - [ ] Day 21: Example integrations (GitHub, Weather).
- Phase 4 — Agents
  - [ ] Day 22–24: Sub-agent spawning + messaging.
  - [ ] Day 25–26: Multi-agent coordination.
  - [ ] Day 27–28: Polish + demos.

## 17) Async Architecture (Critical)

All backend operations must be asynchronous to prevent UI freezing:

### Async Operations
- [ ] API calls to Ollama (can take 10+ seconds)
- [ ] SQLite reads/writes (especially large workspaces)
- [ ] File system operations (save/load/export)
- [ ] HTML sanitization (large payloads)
- [ ] Keychain operations
- [ ] Background auto-save task

### Tokio Runtime Setup
- [ ] Configure Tokio runtime in main.rs
- [ ] Use `#[tokio::main]` for async main
- [ ] All Tauri commands marked `async`
- [ ] Use `.await` for all I/O operations

### Non-blocking Patterns
- [ ] Long operations emit progress events to UI
- [ ] Show loading states in frontend
- [ ] Cancellable operations (use `tokio::select!`)
- [ ] Timeout handling for API calls
- [ ] Background tasks don't block main thread

### Example Command Structure
```rust
#[tauri::command]
async fn execute_command(
    command: Command,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    // All I/O uses .await
    let result = some_async_operation().await?;
    Ok(())
}
```



