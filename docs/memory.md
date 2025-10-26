# Memory & State Management

Last updated: 2025-01-15

This guide explains how UICP stores UI state, replays commands after restarts, and keeps in-memory caches coherent with the persisted log. Treat it as the canonical reference for agents and contributors touching persistence, replay, or cache behaviour.

## Scopes & Stores

State is partitioned into three logical scopes that map directly to the adapter store (`uicp/src/lib/uicp/state.ts`):

| Scope        | Key prefix                    | Lifecycle                                                     |
| ------------ | ----------------------------- | ------------------------------------------------------------- |
| `window`     | `window:<windowId>`           | Reset automatically on `window.close`; persisted commands drop associated entries via `delete_window_commands`. |
| `workspace`  | `workspace`                   | Lives until `resetWorkspace()`; replay restores prior values. |
| `global`     | `global`                      | Reserved for cross-workspace features (not populated in V1).  |

`data-state-scope` / `data-state-key` attributes update the relevant scope on `input`/`change`. Programmatic mutations use the `state.*` command family:

- `state.set` – upsert value with optional `ttlMs`
- `state.get` – fetch without mutating
- `state.watch` / `state.unwatch` – subscribe UI components to changes

> INVARIANT: All mutations flow through `setStateValue()` so validations, TTL handling, and audit logging remain centralized.

## Command Persistence & Replay

Successful commands are appended to the SQLite `tool_call` table via the Tauri command `persist_command`. Replay fetches rows in creation order (`get_workspace_commands`) and applies them on boot.

- `resetWorkspace()` clears all scopes and deletes persisted commands.
- `destroyWindow()` removes commands tied to the window being closed so it does not resurrect on restart.
- Replay executes in deterministic batches (20 ops per slice) and yields via `requestIdleCallback` to keep the UI responsive (`adapter.replayWorkspace`).
- A per-session op-hash dedupe prevents duplicate rows from reapplying during a single replay pass.

> INVARIANT: Replay never reorders commands—destroy-before-create scenarios must be handled by authored sequences, not by hoisting in adapter logic.

If replay encounters a validation error, the adapter throws (`UICPValidationError`) and halts with a surfaced toast plus system message. No commands are silently skipped. `Reset workspace` remains the escape hatch if manual recovery is required.

## Recovery Safe Mode

Startup validation checks:

1. `quick_check` and `foreign_key_check` run before replay; failures enter Safe Mode.
2. When in Safe Mode, command execution is blocked and a recovery modal is surfaced to the user.
3. Recovery options (per `docs/compute/testing.md`):
   - Reindex database
   - Compact the command log to the last good checkpoint
   - Roll back to a persisted snapshot

These flows reuse the persistence helpers in `uicp/src-tauri/src/app.rs` and the integration tests under `uicp/src-tauri/tests/integration_persistence`.

## Cache & Determinism

The compute plane uses `compute_cache` (SQLite) to memoize deterministic runs:

- Keys: `(workspace_id, hash(task,input,envHash))`.
- `canonicalize_input()` sorts JSON keys, escapes JS separators, and forbids non-finite numbers to ensure stable hashing.
- Hits return persisted final envelopes without re-executing Wasm jobs. Metrics (`durationMs`, `cacheHit`, `outputHash`) replay exactly as captured.

> INVARIANT: All replayable jobs must set `replayable=true` and provide an `envHash` so seeds remain stable.

## Memory Hygiene

- Workspace files live under the OS-specific data directory in the `files` subdirectory:
  - Linux: `~/.local/share/UICP/files`
  - macOS: `~/Library/Application Support/UICP/files`
  - Windows: `%APPDATA%\UICP\files`
  - Override via `UICP_DATA_DIR` environment variable
- Compute jobs read via `ws:/files/**` only when the `fs_read` capability is granted.
- `resetWorkspace({ deleteFiles: true })` is intentionally unimplemented in V1 to avoid accidental data loss—delete files via host OS if needed.
- The compute store retains at most 100 terminal jobs (`useComputeStore`) to cap memory usage while preserving recent metrics and logs.

## Observability

- `performance.mark` points (`compute-store-*`) timestamp state transitions for profiling.
- `workspace-replay-progress` / `workspace-replay-complete` DOM events emit `{ total, processed, applied, errors }` so overlays can render progress.
- The compute summary (`summarizeComputeJobs`) exposes p50/p95 duration and memory peaks to feed dashboards.

## References

- Adapter and state logic: `uicp/src/lib/uicp/adapter.ts`, `uicp/src/lib/uicp/state.ts`
- Persistence commands: `uicp/src-tauri/src/app.rs`
- Compute cache: `uicp/src-tauri/src/compute_cache.rs`
- Tests:
  - `uicp/tests/unit/adapter.replay.test.ts`
  - `uicp/src-tauri/tests/integration_persistence/*.rs`
  - `uicp/src-tauri/tests/integration_compute/kill_replay_shakedown.rs`

Keep this document updated when persistence semantics, replay order, or compute caching change. Every change must include regression tests that exercise the relevant invariants.
