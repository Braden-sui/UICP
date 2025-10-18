# UICP V1 Acceptance Criteria

Purpose
- Define the exact gates required to declare V1 complete.
- Keep the list practical, testable, and traceable to CI and docs.

Scope
- Windows MVP (Tauri + React) with local-first persistence and cloud LLM inference.
- Planner (DeepSeek) + Actor (Qwen) orchestration using UICP operations only.

Functional
- Utility apps work end-to-end:
  - Notepad: title/body, Save to Desktop via `api.call` tauri://fs/writeTextFile, status via `dom.set`.
  - Todo: add, complete, delete; list renders via `dom.set`.
  - Calculator: basic operations with instant result.
  - Timer: start/stop/reset; visible countdown.
- Clarify flow: when intent lacks essentials, Planner renders a Clarify window; Submit triggers `uicp://intent` and the pipeline restarts with merged context.
- Full Control gate: OFF → preview plan; ON → auto-apply; STOP cancels and locks until re-consented.

Reliability & Safety
- HTML sanitizer blocks `<script>`, `<style>`, `on*` handlers, and `javascript:` URLs; unsafe HTML is rejected at validation.
- Planner/Actor fallback messages surface in UI when triggered.
- Queue enforces FIFO per-window, idempotency keys drop duplicates, and `txn.cancel` clears queues immediately.

Persistence
- Workspace/window state persists to SQLite in `~/Documents/UICP/` and restores on restart.
- **Command persistence** (implemented 2025-10-06):
  - All successfully executed commands persist to `tool_call` table after execution.
  - On app startup, `replayWorkspace()` fetches and replays all commands in creation order.
  - Window closure deletes window-specific commands (prevents closed windows from reappearing).
  - Workspace reset clears all persisted commands.
  - **Acceptance test**: Build notepad → close app → reopen → notepad reappears with last state.
  - Adapter safety net: if a batch targets a missing window (`window.update`, `dom.*`, `component.render`), a shell window is auto-created and the synthetic `window.create` is persisted to keep replay consistent.
- Save indicator events reflect success/failure.

Performance
- End-to-end (cloud) intent → functional window ≤ 35s under normal conditions.
 
- Early-stop parsing returns immediately when a complete JSON payload is detected.

Observability & UX
- System messages include phase/fallback notices and trace IDs.
- Toasts surface apply success/errors and save status.
- Logs window accessible via desktop menu.
 - Planner/actor receive an Environment Snapshot (agent flags, open windows, last trace, DOM summary) to improve context-awareness.

Security & Config
- Cloud path uses `https://ollama.com/api/chat`; local uses `/v1/chat/completions`.
- Cloud host must not include `/v1` (runtime assertion in place).
- API key stored locally in `~/Documents/UICP/.env`.

Tests & CI
- Unit: schemas, sanitizer, orchestrator/aggregator, STOP/cancel, queue semantics.
- E2E: preview→Apply path; STOP smoke.
- E2E (future): Persistence flow (build app → close → reopen → verify state restored).
- CI: lint, typecheck, unit, e2e, build all green.

Release Declaration (V1)
- Open PR: “V1: Generative Desktop (Windows MVP)” including:
  - Link to this document and checklist status.
  - E2E artifacts (screenshots/logs) for notepad/todo/calculator/timer.
  - Coverage summary and CI run link.
- Tag `v1.0.0` on merge; publish release notes summarizing scope, risks, and next milestones (External APIs).
- Update `CHANGELOG.md` with a V1 section.

Sign-off
- Engineering Lead: ________  Date: ________
- Product/Owner:   ________  Date: ________
