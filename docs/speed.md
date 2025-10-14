# Runtime Speed Improvements (2025-10-13)

This note captures the performance work completed in the current iteration so new contributors can orient quickly.

## Renderer changes

- **Compute metrics** now derive from a single memoized pass in `src/state/compute.ts`. The `summarizeComputeJobs` helper caches the last snapshot so panels can refresh without re-walking the entire job map.
- **Intent telemetry** is buffered via a fixed-size ring (`telemetryBufferToArray`), removing repeated array cloning and lowering render churn in `MetricsPanel` and `LogsPanel`.
- **Instrumentation hooks**: both stores mark updates with `performance.mark` (e.g., `compute-store-upsert`, `intent-telemetry-upsert`) so WebView profiling can line up with host spans.

## Workspace replay

- Replay is now chunked (`20` commands per batch) and yields through `requestIdleCallback` (with `setTimeout` fallback). Two custom events are emitted:
  - `workspace-replay-progress` — `{ total, processed, applied, errors }`
  - `workspace-replay-complete` — same shape, with `done: true`
- Panels or overlays can listen for these events to surface progress without blocking paint.

## Host updates

- Added an `install_modules` tracing span covering bundled module verification.
- Rate limiter backpressure now computes dynamic sleep durations (microsecond-range) instead of fixed 10 ms waits, reducing host CPU wakeups during heavy stdout/stderr traffic.
- `get_workspace_commands` continues to run on the tokio-rusqlite worker but now reports duration and row count through `tracing`.

## Testing

- `npm run test -- --run tests/unit/compute.summary.test.ts tests/unit/app.telemetry.test.ts`
- `cargo test --lib --no-run` (the compute crate rebuilt after the throttling changes)

Keep this file in sync as further speed work lands so we can track what has already shipped and what remains on the backlog.
