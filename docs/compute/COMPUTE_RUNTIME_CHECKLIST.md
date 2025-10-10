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
  - `add_wasi_and_host` links WASI Preview 2 only when `uicp_wasi_enable` is enabled (`uicp/src-tauri/src/compute.rs:640`); disabled builds surface a guidance error.
  - TODO: wire explicit read-only preopens, stdout/stderr bindings, and policy-driven caps before exposing guest FS/IO.

- [x] Guest export invocation (execution wiring)
  - Host invokes typed exports via `get_typed_func` and routes success through `finalize_ok_with_metrics` (`uicp/src-tauri/src/compute.rs:516`).
    - `csv.parse` resolves workspace inputs via `resolve_csv_source`; `table.query` converts JSON into WIT tuples before invocation.
    - Cache writes persist the output and `outputHash`, keeping replay parity.
  - Optional: `uicp_bindgen` feature can be re-enabled later, but it is not required for the current path.

- [ ] Partial event streaming and guest logs
  - `Ctx` tracks partial/invalid frame counters and the bridge listens for `compute.result.partial` (`uicp/src-tauri/src/compute.rs:252`, `uicp/src/lib/bridge/tauri.ts:396`), but the host does not emit partial frames yet; guest stdout/stderr/log imports remain TODO.

- [~] Metrics finishing pass
  - `collect_metrics` (success path) now emits duration, `deadlineMs`, `remainingMsAtFinish`, `logCount`, and partial counters (`uicp/src-tauri/src/compute.rs:842`).
  - TODO: hook `fuelUsed`/`memPeakMb`, attach metrics on error envelopes, and surface counts in UI/telemetry.

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

- [~] UI affordances for compute
  - Compute store tracks duration, cache hits, partial counters (`uicp/src/state/compute.ts:5`), and bridge toasts now map codes via `formatComputeErrorToast` (`uicp/src/lib/bridge/tauri.ts:152`).
  - TODO: render partial frames/metrics in UI, surface cache hits, and add dedicated compute panel indicators.

-------------------------------------------------------------------------------

## 4) Modules and Interface Contract

- [x] Manifest + installer + verifier
  - Files: `uicp/src-tauri/src/registry.rs`, `verify_modules` command, `scripts/update-manifest.mjs`

- [x] Build/publish scripts
  - File: `uicp/package.json` (`modules:build:*`, `modules:update:*`, `modules:verify`)

- [~] Guest ABI contract
  - World decided: `world command` with `interface csv` and `interface table`; shared `rows` type via `interface common`.
    - File: `uicp/src-tauri/wit/command.wit`
  - Bindgen is optional; current host path uses typed funcs directly. `uicp_bindgen` may be enabled in the future if desired.
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

- [~] Per-task metrics
  - Final Ok envelopes include duration, deadline budget, log/partial counters, and `outputHash`; cache persistence keeps metrics (`uicp/src-tauri/src/compute.rs:842`).
  - TODO: add mem/fuel capture, expose metrics in UI dashboards, and include error-path metrics.

- [ ] Logs/trace capture
  - Map guest stdout/stderr or host “log” import to frames; redact/sanitize

-------------------------------------------------------------------------------

## 7) CI/CD and Build Matrix

- [x] Module verification workflow present (`.github/workflows/verify-modules.yml`)

- [~] Compute build jobs
  - `rust-compute-build` CI job runs `cargo check`/`cargo build` with `wasm_compute,uicp_wasi_enable` (`.github/workflows/ci.yml:134`).
  - TODO: add feature-on `cargo test` and integrate Wasm component build smoke.

- [ ] E2E smoke for compute
  - Headed/CI-friendly run that starts Tauri (or harness bin) and executes one component

-------------------------------------------------------------------------------

## 8) Documentation

- [x] Baseline docs present: `docs/compute/README.md`, host skeleton (`docs/compute/host-skeleton.rs`), WIT draft

- [~] Update docs with:
  - Feature flags + enablement now covered in `docs/setup.md#wasm-compute`; module build/verify flow documented in `docs/compute/README.md`.
  - Error taxonomy captured in `docs/compute/error-taxonomy.md`; compute toasts reference these codes.
  - TODO: add determinism/record-replay guarantees, guest log policy, and UI surfacing guidelines.

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

