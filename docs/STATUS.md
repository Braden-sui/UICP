# Project Status (Snapshot)

Purpose: one-page, human-readable snapshot of what is Done, In Progress, Next, plus risks and CI health. This page is the entry point for status; deeper, authoritative checklists remain in docs/MVP checklist.md and docs/compute/COMPUTE_RUNTIME_CHECKLIST.md.

Last updated: 2025-10-17

## Summary

- Desktop app (React + Tauri) runs with MOCK mode by default; when opened in a plain browser the UI now degrades gracefully instead of crashing, while the Tauri bridge continues to drive native flows.
- Compute plane (Wasmtime, feature-gated) is implemented with registry, cache, and policy; compute harness E2E smoke now runs in CI to guard guest/host drift.
- CI runs lint, typecheck, unit, e2e (mock), build, security scans, and link checking.

## Now (Current Focus)

- Finalize guest ABI contract docs (document host imports + schemas, freeze changelog).
- Implement component feature preflight to reject unsupported Wasm metadata before instantiation.
- Wire compute metrics (p50/p95 duration, cache ratio) into Devtools dashboards and production observability.

## Done (Recently)

**October 2025 Work** (see `docs/IMPLEMENTATION_LOG.md` for details):

- **Batch idempotency system**: FNV-1a hash-based deduplication prevents duplicate batch application from retries/races. In-memory LRU with 15-min TTL, telemetry events for skipped duplicates.
- **Stream cancellation**: Explicit `cancel()` API with zero ghost echoes proven by soak tests. Cancelled streams never reach `onBatch` callback.
- **Workspace registration guard**: Early batches queue until `Desktop.tsx` mounts, eliminating "Workspace root not registered" race condition.
- **Telemetry ID tracking**: `batchId` and `runId` now tracked end-to-end. MetricsPanel and LogsPanel show full correlation. Enables plan→act→apply→batch debugging.
- **JSON tool calling**: Production default for GLM 4.6 with 4-level cascading fallback (tool→json→WIL→commentary). `channelUsed` field tracks which path succeeded.
- **Error handling refactor**: Eliminated silent error paths. `emitWindowEvent` throws on failures, `stableStringify` removed lossy fallback, JSON recovery limited to pre-validation cleanup.
- **Circuit breaker observability**: Configurable thresholds via env vars, `debug_circuits` command, telemetry events for open/close transitions.
- **SQLite maintenance**: Periodic WAL checkpoint, VACUUM, PRAGMA optimize. Schema versioning with migration guards.
- **Performance improvements**: Ring buffer for telemetry (no array cloning), memoized compute metrics, chunked workspace replay with progress events, dynamic throttle sleep.
- State & testing foundation documented (`docs/memory.md`, `docs/TEST_PLAN_LEAN.md`); error-handling note updated to match fail-loud behaviour.
- Adapter `data-command` path throws `E-UICP-301` on malformed/empty payloads; LLM iterator teardown logs `E-UICP-401`.
- UI bridge shims guard all `invoke` usage so Agent Settings, Compute Demo, and System Banner behave sensibly when Tauri is absent (prevents the “Cannot read properties of undefined (reading 'invoke')” crash).
- Component preflight enforces per-task import allowlists before instantiation (rejects modules importing `wasi:http`/etc).
- Compute observability gaps closed: float canonicalization tests added, RNG/clock determinism proven, host harness smoke runs under `STRICT_MODULES_VERIFY` in CI.
- CI pins Wasmtime 37 and runs headless compute harness + Playwright smoke against signed modules.

## In Progress

- Completing guest ABI freeze and WIT documentation drift checks.
- Component metadata preflight & strict signature enforcement for release packaging.
- UI polish for compute dashboards (alerts + charts) fed by new metrics summary.

## Next (Planned)

- Automate WIT binding drift detection directly in CI (failing when `npm run gen:io` produces diffs).
- Add dashboards/alerts for compute success/error rates, cache hit ratio, throttle counters.
- Expand negative guest modules (timeout, OOM) to validate policy end-to-end under Playwright harness.

## Open Bugs/Quirks

- Rust compute build currently fails on `Component::imports` (Wasmtime API drift). Track upstream change or adjust host code before re-enabling `cargo test --features wasm_compute`.
- Windows-only postinstall: safe to run on Linux/macOS; document in setup (done).

## Risks/Blockers

- Cross-platform native binding quirks (Rollup) — mitigated via `ROLLUP_SKIP_NODE_NATIVE` wrapper and postinstall repair on Windows.
- Cloud rate limits — mitigated via per-host circuit breaker and surfaced retry hints.
- Compute is feature-gated; enablement without modules may confuse users — mitigated via Agent Settings + docs.

## Test/CI Health

- UI: lint, typecheck, unit, e2e (mock), build all pass locally when Node 20/npm 10 are used.
- Compute: Rust tests plus compute harness smoke run in CI; local `cargo test --features wasm_compute` currently blocked by Wasmtime API drift (see Open Bugs).
- Link checks: configured via `.lychee.toml`.

## Pointers (Authoritative Lists)

- MVP scope and status: docs/MVP checklist.md
- Compute runtime checklist: docs/compute/COMPUTE_RUNTIME_CHECKLIST.md
- Architecture overview: docs/architecture.md
- Model usage and endpoints: docs/model-usage.md, docs/ollama cloud vs. turbo.md

## Working Agreement (lightweight)

- Keep this snapshot accurate; update when you land meaningful changes.
- Treat checklists as the source of truth for acceptance criteria; this page summarizes and links.
