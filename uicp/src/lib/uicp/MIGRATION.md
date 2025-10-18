## Adapter Module Split (2025-10-17)

The monolithic `adapter.ts` has been decomposed into focused modules. Downstream code continues to import from
`uicp/src/lib/uicp/adapter`, which now re-exports a stable façade.

### New Modules

- `adapter.lifecycle.ts` – Workspace/window lifecycle, DOM mutation helpers, event delegation, state stores, and
  `applyCommand`.
- `adapter.queue.ts` – Batch application orchestration with idempotency (tracks `{batchId, opsHash}` for 10 minutes),
  exported `applyBatch`, `ApplyOptions`, `ApplyOutcome`, and reset hooks.
- `adapter.security.ts` – Centralised permission check proxy and HTML utilities (`checkPermission`, `sanitizeHtmlStrict`,
  `escapeHtml`).
- `adapter.fs.ts` – `safeWrite` wrapper around `@tauri-apps/plugin-fs` enforcing path normalization, desktop gating via
  `devDesktopWrite`, confirmation prompts, and telemetry logging.
- `adapter.testkit.ts` – Pure helpers for unit tests (`buildComponentMarkupForTest`).

The façade (`adapter.ts`) re-exports only the documented surface (register/reset/replay APIs, `applyBatch`, test kit hook).

### Batch Application Changes

- `applyBatch(batch, opts?)` accepts optional `runId`, `batchId`, `opsHash`, `allowPartial`.
- Idempotency: duplicates are skipped if either `batchId` matches or `opsHash` reappears within 10 minutes (bounded LRU).
- `ApplyOutcome` now exposes `skippedDupes` (with `skippedDuplicates` retained for compatibility), plus `batchId`,
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
