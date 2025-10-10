# Compute Runtime: Master Checklist

Purpose: single source of truth for the compute plane (Rust host + TS frontend). Tracks what is done and what remains, with pointers to code. Treat this as an execution plan and review artifact.

Legend
- [x] complete and verified locally (builds/tests pass)
- [ ] pending
- [~] partial/in progress

-------------------------------------------------------------------------------

## 1) Host Runtime (Rust)

- [x] Feature-gated host scaffolding
  - Files: `uicp/src-tauri/src/compute.rs`, `uicp/src-tauri/Cargo.toml`
  - `wasm_compute` enables Wasmtime; fallback path returns structured error when disabled

- [x] Engine configuration
  - Component model + async + fuel + epoch interruption configured (`build_engine()`)
  - `StoreLimits` attached; memory cap derived from `mem_limit_mb`

- [x] Resource enforcement
  - CPU: `add_fuel(DEFAULT_FUEL or spec.fuel)` and epoch deadline with background epoch pump
  - Memory: `StoreLimitsBuilder::memory_size` with default 256MB unless overridden and policy-allowed

- [x] Job lifecycle and cancellation
  - Per-job cancel channel via `compute_cancel` map in `AppState`
  - Cancel propagation into store context (`Ctx.cancelled`) and hard abort fallback after grace
  - Cleanup removes entries from `compute_cancel` and `compute_ongoing` maps

- [x] Module registry and manifest handling
  - Files: `uicp/src-tauri/src/registry.rs`, installer called from `main.rs` setup
  - Bundled install if user dir missing; digest verification; optional signature check

- [x] Policy layer at call boundary (timeouts, memory, fs, net)
  - File: `uicp/src-tauri/src/main.rs: compute_call`
  - Enforces timeout bounds, long-run + mem_high caps, denies network, constrains ws:/ paths

- [x] Workspace path hygiene (ws:/files)
  - Canonicalization + traversal rejects; symlink escape prevented
  - Tests in `compute.rs` for traversal + symlink (unix-only)

- [x] Error taxonomy and mapping
  - `error_codes` centralized; trap mapping returns `Timeout`, `Resource.Limit`, `Task.NotFound`, `CapabilityDenied`, `Runtime.Fault`

- [x] Telemetry and cache writes
  - Emits `debug-log`, `compute.result.final`; caches deterministic payloads when replayable

- [~] WASI imports
  - Core P2 wired behind `uicp_wasi_enable`; disabled path now errors with guidance
  - Pending: define precise preopens/policy and stdio/log bindings

- [~] Guest export invocation (execution wiring)
  - Current state: typed export invocation wired in host (`uicp/src-tauri/src/compute.rs`) using Wasmtime Component typed API.
    - csv.parse: calls `csv#run(job_id, source, has_header)` after enforcing `ws:/files` policy and resolving to data: URL when needed
    - table.query: calls `table#run(job_id, rows, select, where_contains)` with validated JSON → WIT mapping
    - Success path emits `compute.result.final` with metrics via `finalize_ok_with_metrics()`; errors mapped via `map_trap_error()`
  - Remaining: generate and gate WIT bindings (`uicp_bindgen`), enrich metrics (fuelUsed, memPeakMb), and add partial event streaming

- [ ] Partial event streaming and guest logs
  - TODO: surface `compute.result.partial` frames with seq, and count/log metrics (`partialFrames`, `invalidPartialsDropped`)

- [ ] Metrics finishing pass
  - Implement `collect_metrics` usage on success/error; emit `fuelUsed`, `memPeakMb` (if obtainable), `deadlineMs`, `remainingMsAtFinish`, `logCount`

-------------------------------------------------------------------------------

## 2) App Shell and Orchestration (Rust/Tauri)

- [x] AppState and concurrency
  - Fields for compute in-flight map, cancel map, and semaphore cap

- [x] Commands
  - `compute_call`, `compute_cancel`, `verify_modules`, `clear_compute_cache`, `copy_into_files`, `get_modules_info`

- [x] Cache semantics
  - CA lookups keyed by task+input+env; readOnly vs readwrite policy handled

- [x] Health/safe-mode
  - DB quick_check and safe-mode toggles; replay telemetry stream

- [ ] E2E harness for compute
  - TODO: add a Playwright/Vitest path that submits a small wasm task and observes terminal OK result

-------------------------------------------------------------------------------

## 3) Frontend State + Bridge (TypeScript)

- [x] Job store correctness and ergonomics
  - File: `uicp/src/state/compute.ts`
  - Pruning keeps all active and up to N terminal; added `markQueued`, `markRunning`, `removeJob`
  - Status mapping tolerant to `Compute.*` codes and message prefixes (timeout/cancelled)

- [x] Bridge event handling
  - File: `uicp/src/lib/bridge/tauri.ts`
  - `markFinal` now receives both message and code; binds apply on OK; partial increments

- [x] Unit tests
  - File: `uicp/tests/unit/compute.store.test.ts` covers new semantics and helpers

- [ ] UI affordances for compute
  - TODO: add panel/indicators for partials, metrics, cancel, cache-hit iconography
  - TODO: unify error toasts with code taxonomy (`errors.ts`)

-------------------------------------------------------------------------------

## 4) Modules and Interface Contract

- [x] Manifest + installer + verifier
  - Files: `uicp/src-tauri/src/registry.rs`, `verify_modules` command, `scripts/update-manifest.mjs`

- [x] Build/publish scripts
  - File: `uicp/package.json` (`modules:build:*`, `modules:update:*`, `modules:verify`)

- [ ] Guest ABI contract
  - Decide WIT world and finalize (`uicp/src-tauri/wit/command.wit`, `docs/wit/uicp-host@1.0.0.wit`)
  - Enable `uicp_bindgen` feature and generate bindings for the chosen world
  - Document the request/response schema and error mapping invariants

- [ ] Minimum viable component(s)
  - Add a tiny “echo” or `csv.parse` component with verified digest in the manifest
  - E2E test: submit input, verify OK output and metrics populated

-------------------------------------------------------------------------------

## 5) Security & Policy

- [x] Capability enforcement in host and call boundary
  - Denied: network by default; strict ws:/ path scoping; timeout/memory caps

- [x] Symlink and traversal protection for workspace files
  - Canonicalization and base-dir prefix assertion

- [ ] WASI surface hardening
  - Preopens read-only; no ambient authority; restrict clocks/random if determinism is required

- [ ] Negative tests
  - Add tests that ensure violations (net/fs/timeouts) fail with the correct error codes and logs

-------------------------------------------------------------------------------

## 6) Observability

- [x] Structured events
  - `debug-log`, `compute.result.final`, `compute.debug` telemetry; replay telemetry

- [ ] Per-task metrics
  - Populate and persist duration/fuel/memory/log counts; add app UI counters/chart if needed

- [ ] Logs/trace capture
  - Map guest stdout/stderr or host “log” import to frames; redact/sanitize

-------------------------------------------------------------------------------

## 7) CI/CD and Build Matrix

- [x] Module verification workflow present (`.github/workflows/verify-modules.yml`)

- [ ] Compute build jobs
  - Add `cargo check/test` with `--features wasm_compute,uicp_wasi_enable`
  - Run Rust unit tests (including `compute.rs`) and TypeScript unit tests

- [ ] E2E smoke for compute
  - Headed/CI-friendly run that starts Tauri (or harness bin) and executes one component

-------------------------------------------------------------------------------

## 8) Documentation

- [x] Baseline docs present: `docs/compute/README.md`, host skeleton (`docs/compute/host-skeleton.rs`), WIT draft

- [ ] Update docs with:
  - Feature flags and when to enable (`wasm_compute`, `uicp_wasi_enable`, `uicp_bindgen`)
  - Module install/verify flow, expected directory layout, cache behavior
  - Error taxonomy for frontend and how to surface it (toasts, logs)
  - Determinism/record-replay guarantees and limitations

-------------------------------------------------------------------------------

## 9) Release Gates (Go/No-Go)

- [ ] Guest export wiring complete; csv.parse/table.query MVP runs end-to-end on local
- [ ] WASI imports limited to policy; fs preopens verified to sandbox
- [ ] Unit + integration + E2E suites green (Rust + TS)
- [ ] CI builds with features on; module verifier green
- [ ] Docs updated; feature flags default for release decided

-------------------------------------------------------------------------------

## 10) Nice-to-haves (Post-MVP)

- [ ] Determinism probes for compute outputs and optional golden tests
- [ ] Resource budgets/benchmarks (latency p95 deltas on changed path)
- [ ] Cache warming and cache-only mode for demos
- [ ] Per-job log/metrics view in the UI

-------------------------------------------------------------------------------

## Cross-References (Key Files)

- Host runtime: `uicp/src-tauri/src/compute.rs`
- App shell: `uicp/src-tauri/src/main.rs`
- Registry + modules: `uicp/src-tauri/src/registry.rs`, `uicp/src-tauri/modules/*`
- Cache: `uicp/src-tauri/src/compute_cache.rs`
- Frontend store: `uicp/src/state/compute.ts`
- Bridge: `uicp/src/lib/bridge/tauri.ts`
- Tests: `uicp/tests/unit/compute.store.test.ts`, Rust unit tests in `compute.rs`
- Work-in-progress WIT: `uicp/src-tauri/wit/command.wit`, `docs/wit/uicp-host@1.0.0.wit`

