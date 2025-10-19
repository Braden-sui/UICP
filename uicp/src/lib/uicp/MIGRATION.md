## Adapter V2 Architecture (2025-10-19)

The adapter has been refactored into a modular v2 architecture. The v1 monolith (`adapter.lifecycle.ts`, 971 lines) has been **completely removed**. Downstream code continues to import from `uicp/src/lib/uicp/adapter`, which now re-exports the v2 implementation.

### V2 Modules (Production)

**Core Orchestration:**

- `lifecycle.ts` – Main orchestrator with workspace management, batch application, and operation routing.

**Specialized Modules:**

- `windowManager.ts` – Window lifecycle operations (create, move, resize, focus, close).
- `domApplier.ts` – DOM mutations with content deduplication and sanitization.
- `componentRenderer.ts` – Component rendering factory with known type registry.
- `permissionGate.ts` – Permission check wrapper around PermissionManager.
- `adapter.telemetry.ts` – Telemetry event helpers with context enrichment.

**Supporting Infrastructure:**

- `adapter.clarifier.ts` – Clarification flow for structured input collection.
- `adapter.api.ts` – API route handler for external HTTP calls.
- `adapter.persistence.ts` – Command persistence and workspace replay.
- `adapter.events.ts` – Event delegation setup for data-command handling.
- `adapter.queue.ts` – Batch orchestration with idempotency (tracks `{batchId, opsHash}` for 10 minutes).
- `adapter.security.ts` – HTML sanitization utilities (`sanitizeHtmlStrict`, `escapeHtml`).
- `adapter.fs.ts` – Safe file write wrapper with permission checks.
- `adapter.testkit.ts` – Test helpers and mocks.

The façade (`adapter.ts`) re-exports only the documented surface (register/reset/replay APIs, `applyBatch`, test kit).

### Batch Application Changes

- `applyBatch(batch, opts?)` accepts optional `runId`, `batchId`, `opsHash`, `allowPartial`.
- Idempotency: duplicates are skipped if either `batchId` matches or `opsHash` reappears within 10 minutes (bounded LRU).
- `ApplyOutcome` now exposes `skippedDupes` (single canonical field), plus `batchId`,
  `opsHash`, and `errors`.
- Workspace resets notify the queue layer via `addWorkspaceResetHandler`.

### Safe File Writes

- `safeWrite` only permits relative paths beneath `BaseDirectory.AppData` (default) unless `devDesktopWrite: true`.
- Desktop exports always require user confirmation (`@tauri-apps/plugin-dialog.confirm`).
- Rejects absolute paths, traversal attempts (`..`), and non HTTPS/mailto when relevant.
- Emits telemetry event `safe_write` with `{ path, size, ok, errorCode }`.

### Testing

- New unit suites cover `safeWrite` traversal/desktop gating, queue idempotency (`batchId` + `opsHash` scenarios), and
  sanitizer snapshots.
- All tests continue to import from the façade; deep paths remain internal.

Follow this structure when extending adapter behaviour: keep lifecycle code in `adapter.lifecycle.ts`, reuse `safeWrite`
for file IO, and expose new public methods from the façade only when required by the external API contract.
