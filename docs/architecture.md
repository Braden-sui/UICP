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
- **Models:** Planner uses DeepSeek V3.1 (`deepseek-v3.1:671b`) or Kimi K2 (`kimi-k2:1t`); Actor uses Qwen3-Coder (`qwen3-coder:480b`) or Kimi K2. Cloud models use colon-tag IDs; local daemon accessible via `/v1` endpoints.

## Data Flow

## Happy Path Sequence

```
sequenceDiagram
  participant User
  participant Planner
  participant Actor
  participant Adapter
  participant Persistence
  participant Compute

  User->>Planner: Describe intent
  Planner->>Actor: Step 1 spec
  Actor->>Adapter: Validated data-ops
  Adapter->>Persistence: Append ops to log
  Adapter->>Compute: compute.call (if any)
  Compute-->>Adapter: compute.result.partial/final
  Adapter->>Adapter: Materialize to state
  Adapter-->>User: UI updated
```

## Environment Snapshot

Purpose
- Give models stable, minimal context that explains what they can see and do without leaking secrets or huge blobs.

Contents
- `app`: `{ version, build, feature_flags[] }`
- `os`: `{ family, version, locale }`
- `workspace`: `{ id, name, created_at }`
- `windows`: summary list `[{ id, title, route, size }]`
- `modules`: `[{ name, version, enabled }]`
- `policy`: `{ net_allowed: false|true, fs_roots: ["ws:/..."] }`
- `seeds`: `{ rng_seed_prefix }`
- `clock`: logical timestamp (not wall clock)
- `envHash`: sha256 over the canonicalized snapshot

Size budget
- Target 16 KB. Hard cap 32 KB.

Truncation rules
- Drop window list beyond 10 entries with “...truncated”.
- Drop module private metadata.
- Never include file contents, only URIs and digests.
- Deterministic ordering of keys and arrays.
1. **User Action:** prompts or clicks UI element.
2. **Frontend -> Backend:** `streamOllamaCompletion(messages, model, tools, { requestId })` registers a listener for `ollama-completion` events before invoking the `chat_completion` Tauri command. The iterator returns content/tool_call/done events and supports early cancellation via `cancel_chat(requestId)` when the consumer stops.
3. **Backend:**
   - Persists state to SQLite.
   - Dispatches tool commands.
   - Calls Ollama Cloud via HTTPS using `https://ollama.com` (no `/v1`).
   - Calls the local daemon using `http://127.0.0.1:11434/v1` when `USE_DIRECT_CLOUD=0`.
   - For `chat_completion`, spawns the streaming HTTP task keyed by `request_id` and emits `ollama-completion` events. `cancel_chat` aborts the task when requested.
4. **Frontend Aggregation:** the Tauri bridge accumulates commentary-channel deltas and attempts a fast parse on each chunk. If a complete JSON object/array appears, it short-circuits; otherwise it parses on completion. A gating callback then decides:
  - Suppress preview/apply when the orchestrator is running (prevents duplicate apply).
  - Auto-apply via the queue when Full Control is enabled.
  - Otherwise set a pending plan preview.
5. **Frontend Rendering:** updates React state (windows, modals, indicators), renders sanitized HTML under `#workspace-root`, surfaces the desktop menu bar backed by workspace window metadata, and keeps a menu-controlled Logs panel so users can review the conversation history (user / assistant / system messages with timestamps and error codes).

## Interactivity Runtime (no JS in model output)
- Inputs/Textareas with `data-state-scope` + `data-state-key` auto-update in-memory state on `input`/`change`.
- Any clickable or form element may include `data-command` with a JSON batch to enqueue on `click`/`submit`.
- Template tokens inside `data-command` strings are resolved at event time: `{{value}}`, `{{form.FIELD}}`, `{{windowId}}`, `{{componentId}}`.
- `dom.set` is preferred for replacing specific regions; `dom.append` adds content without re-rendering entire windows.

Hard rules for models:
- Never emit event APIs (e.g., `event.addListener`, `addEventListener`, custom `event.*` ops). All interactivity is declared via attributes; the runtime executes them. See also: `uicp/src/prompts/actor.txt`.
- Always include a valid `windowId` for `dom.*` and `component.render` operations.

### Follow-up intents from UI
- Planner-built forms can trigger a new chat run with `api.call` using the special URL `uicp://intent` and body `{ text }`.
- The frontend adapter dispatches a `uicp-intent` CustomEvent. The bridge merges `{ text }` with the most recent user message as:
  `"<last user message>\n\nAdditional details: <text>"`, then calls the chat store's `sendMessage(merged)` so the planner gets the full context.

## File IO (Tauri)
- `api.call` supports a special scheme `tauri://fs/writeTextFile` to save text files locally.
  - Body: `{ path, contents, directory?: "Desktop" | "Document" | ... }`
- HTTP(S) URLs are fetched best-effort; errors are logged.

## Modules
### Rust (`uicp/src-tauri/src/main.rs`)
- `AppState`: shared state (SQLite path, HTTP client, API key cache).
- `get_paths`: exposes filesystem paths to the frontend.
- `load_api_key` / `save_api_key`: manage `.env` storage.
- `test_api_key`: validates credentials against `https://ollama.com/api/tags` with an `Authorization: Bearer <api-key>` header.
- `load_workspace` / `save_workspace`: persist draggable window layout to SQLite.
- `chat_completion`: streams Ollama Cloud responses (`ollama-completion` events). The HTTP client has no hard timeout; STOP cancels via `cancel_chat`.
- `enqueue_command`: persists agent-generated commands to the SQLite queue (`tool_call` table) so the desktop can replay them deterministically.
- `spawn_autosave`: emits save indicator when state changes.

### Frontend (`uicp/src`)
- `App.tsx`: stitches the desktop canvas, DockChat, and modals; mounts toasts and global providers.
- `components/Desktop.tsx`: registers `#workspace-root`, syncs workspace windows via lifecycle events, and renders the desktop menu bar.
- `components/LogsPanel.tsx`: menu-controlled logs window reflecting chat/system history for auditing.
- `global.css`: base styles, dark/light themes, modal layout, stream preview styling.
- `vite.config.ts`: Vite dev server pinned to port 1420 for Tauri.
- Event listeners (`listen`) keep React state in sync with backend events.
- LLM provider/orchestrator stream commentary JSON and validate via Zod before enqueueing batches.

#### LLM profiles
- `uicp/src/lib/llm/profiles.ts` registers planner/actor profiles: `deepseek`/`kimi` for planner, `qwen`/`kimi` for actor. Each profile owns its prompt formatter, default model name, and capabilities.
- `uicp/src/lib/llm/provider.ts` resolves the active profile (via env/UI) and delegates stream construction to `streamOllamaCompletion`.
- The provider prepends a compact Environment Snapshot (agent mode/phase, open windows, last trace) to planner/actor prompts. The DOM is included by default to improve context awareness; content is trimmed and sanitized for size.

## Ollama Cloud Integration
- Base URL (cloud): `https://ollama.com` (runtime assertion rejects hosts containing `/v1` to prevent config drift)
- Base URL (local): `http://127.0.0.1:11434/v1` (OpenAI-compatible)
- Authentication: `Authorization: Bearer <api-key>` (cloud only).
- Endpoints:
  - Cloud: `GET /api/tags` (validate key, list models), `POST /api/chat` (stream completions)
  - Local: `GET /v1/models`, `POST /v1/chat/completions`
- The HTTP client uses `reqwest` with Rustls TLS.

## Persistence
- SQLite schema (current): `workspace`, `window`, `window_content`, `tool_call` (width/height columns seeded on load).
- Future tables (per checklist): `app_state`, `collection`, `collection_row`, `workflow`.
- Journaling: WAL mode for resilience.

### Command Persistence & Replay (Implemented 2025-10-06)
Apps now persist across restarts via command replay:

**Backend Commands** (main.rs:176-269):
- `persist_command(cmd)`: Inserts command into `tool_call` table after successful execution
  - Stores: `id` (idempotencyKey), `tool` (operation name), `args_json` (params), `workspace_id`, `created_at`
  - Fire-and-forget: failures logged but don't block execution
- `get_workspace_commands()`: Returns all commands for current workspace ordered by creation time
- `clear_workspace_commands()`: Deletes all commands for workspace (called on `resetWorkspace`)
- `delete_window_commands(windowId)`: Deletes commands where:
  - `tool = "window.create" AND args.id = windowId`
  - OR `args.windowId = windowId` (dom.*, component.*, etc.)
  - Called when window closes to prevent it from reappearing on restart

**Frontend Integration** (adapter.ts):
- `persistCommand(envelope)`: Called after successful `applyCommand`
  - Skips ephemeral ops: `txn.cancel`, `state.get`, `state.watch`, `state.unwatch`
  - Async fire-and-forget (errors logged, don't throw)
- `replayWorkspace()`: Called on Desktop mount (Desktop.tsx:42-55)
  - Fetches commands from DB
  - Reapplies in creation order (no reordering); preserves `destroy → create` semantics for stable IDs
  - Returns `{ applied, errors }` for observability
- `resetWorkspace()`: Clears both in-memory state and persisted commands
- `destroyWindow(id)`: Removes window from DOM and deletes its persisted commands

Auto-create safety net:
- When a batch targets a window that is not yet present, the adapter auto-creates a shell for `window.update`, `dom.set`, `dom.replace`, `dom.append`, and `component.render`. The synthetic `window.create` is persisted so replay remains consistent.

**Lifecycle**:
1. User asks agent: "make a notepad"
2. Orchestrator → batch → adapter executes → `persistCommand` fires
3. User closes app
4. User reopens → `replayWorkspace` runs on mount → notepad reappears
5. User closes window via menu → `delete_window_commands` ensures it stays closed
6. User resets workspace → all commands deleted

**Retention**: Commands persist indefinitely until window closed or workspace reset.

## State Management Semantics

State Model and Scopes

- Scope `window`: namespaced by `windowId`. Lifetime equals the window. Not persisted across window close unless persisted via explicit ops.
- Scope `workspace`: shared by all windows within a workspace. Persisted and replayed.
- Scope `global`: shared across all workspaces on the device. Persisted in a separate store.

Ops and Semantics

- `state.set(path, value, scope=workspace)`: atomic replace of the value at `path`. No implicit merge.
- `state.patch(path, object, scope=workspace)`: shallow merge of object keys. Arrays are replaced, not merged.
- `state.clear(path, scope)`: remove key at `path`.

Replay Invariants

- Never apply partial state without recording exactly which step failed.
- Do not auto-delete files under `ws:/files`.
- Errors are terminal envelopes that replay as errors; they are never silently dropped.

Ordering & Replay Behavior

- Within a single replay, ops apply strictly in log order.
- When multiple ops target the same `path` during replay, last write wins.
- Replay replays the exact ops; it does not merge with any existing in-memory state. The in-memory state is replaced by the replayed ops.

After replay completes

- Transient in-memory state that was not persisted is discarded unless a specific module rehydrates it from its own persisted store.

## Replay Recovery

Goal
- If replay cannot complete deterministically, the system must fail safe, keep the UI usable, and guide the user to a clean state.

Definitions
- Replay: reapplying the persisted command log to rebuild state.
- Drift: the materialized state diverges from what the log implies for the same inputs and versions.

Detection
- Schema version check at startup: if `schema_version` in SQLite or log header does not match the running app, mark `NEEDS_MIGRATION`.
- Log integrity: verify content hashes per segment. On mismatch mark `CORRUPT_LOG`.
- SQLite health: `PRAGMA quick_check`. On failure mark `CORRUPT_DB`.
- Determinism probe: spot-check N random checkpoints in the log by recomputing a state hash; if any mismatch, mark `DRIFT`.

Recovery playbook

Enter Safe Mode
- Freeze write ops to persistence.
- Show banner: “Replay issue detected: <reason>. You can attempt restore, roll back to last checkpoint, or start fresh.”

Automated attempts (in order)
- a) Reindex: rebuild SQLite indices and run `PRAGMA integrity_check`.
- b) Compact log: drop trailing incomplete segment and retry replay.
- c) Roll back to last valid checkpoint snapshot, then apply log from that point.
- d) If replayable jobs are missing terminal results, re-enqueue them; otherwise mark as stale.

User choices
- Restore from checkpoint X (recommended).
- Export diagnostics bundle (sanitized log tail + integrity report).
- Start fresh workspace (keeps files in `ws:/files`, resets state and log).

Invariants
- Never apply partial state without recording exactly which step failed.
- Do not auto-delete files under `ws:/files`.
- Errors are terminal envelopes that replay as errors; we do not silently drop them.

Telemetry
- Record `replay_status={ok|reindexed|compacted|rolled_back|failed}`, `failed_reason`, `checkpoint_id`, and counts of re-run jobs.

## Save Indicator Logic
- `AppState.last_save_ok` tracks status.
- Autosave loop polls every 5s and emits only on state change.
- Manual Save button calls `save_workspace` and updates the indicator immediately on success/failure.

## Current Implementation Notes (2025-10-05)
- react-rnd windows persisted to SQLite; default workspace seeded if empty.
- API key stored in `~/Documents/UICP/.env` (Settings modal writes via Tauri command).
- Streaming iterator `streamOllamaCompletion(messages, model, tools, options?)` forwards SSE lines, stamps a requestId, and supports cancellation. The aggregator attempts early JSON detection to return sooner; the orchestrator stamps `traceId`, `txnId`, and `idempotencyKey` on each envelope.

## Timeouts
- Planner timeout defaults to 120s; Actor 180s. Both are configurable via Vite env (`VITE_PLANNER_TIMEOUT_MS`, `VITE_ACTOR_TIMEOUT_MS`). Early-stop parsing returns results as soon as valid JSON is available.
- Plan/Batch validation in frontend: `validatePlan`, `validateBatch` with pointer-based errors and HTML guardrails.
- Logs panel is opened via the desktop menu and mirrors chat/system history for quick auditing.
- Adapter emits window lifecycle events so the desktop menu stays in sync with planner-created windows.

## Planned Extensions
- ~~Tool execution queue with persistence~~ (implemented 2025-10-06; see Command Persistence & Replay above).
- Drift detection for command replay (reconcile DB state with actual DOM).
- Workspace snapshots (save/load named states).
- State/CRUD/`api_call` tools.
- Component library renderer.
- Export (HTML/React) + sharing.
- Linux packaging after Windows MVP.
