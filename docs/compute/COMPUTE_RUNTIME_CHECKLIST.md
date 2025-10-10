# Compute Runtime: Master Checklist

Purpose: single source of truth for the compute plane (Rust host + TS frontend). Tracks what is done and what remains, with pointers to code. Treat this as an execution plan and review artifact.

Legend
- [x] complete and verified locally (builds/tests pass)
- [ ] pending
- [~] partial/in progress

-------------------------------------------------------------------------------

## Execution cadence and time expectations

- The agent works iteratively until each checklist item is delivered or explicitly descoped; there is no fixed "timebox" after which execution stops automatically.
- Progress updates will call out blockers, additional context needed, or environment limitations as soon as they are discovered rather than waiting for a deadline.
- If an explicit calendar deadline is required (for example, to align with a release cut), add it to the relevant checklist item so prioritization and sequencing can be adjusted.

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
    - Current state: Preview 2 core wiring lives behind `uicp_wasi_enable`; when disabled, `add_wasi_and_host` returns a guidance error instead of silently missing imports.
    - TODO (host: `uicp/src-tauri/src/compute.rs`):
      - [ ] Build the per-workspace readonly preopen using `WasiCtxBuilder::new().preopened_dir(...)` so guests can opt into `ws:/files/**` access while still flowing through `sanitize_ws_files_path()` and `fs_read_allowed()` policy guards.【F:uicp/src-tauri/src/compute.rs†L352-L398】
      - [ ] Provide deterministic stdio/log bindings: plumb WASI stdout/stderr and the `uicp:host/logger` import into `ComputePartialEvent` emissions and increment the per-job `log_count` counter (`Ctx.log_count`).【F:uicp/src-tauri/src/compute.rs†L252-L264】【F:uicp/src-tauri/src/main.rs†L270-L305】
      - [ ] Implement host shims for `uicp:host/control`, `uicp:host/rng`, and `uicp:host/clock` so the job-scoped fields (`rng_seed`, `logical_tick`, `deadline_ms`, `remaining_ms`) are observable by guests and captured for replay/metrics.【F:uicp/src-tauri/src/compute.rs†L255-L264】【F:docs/wit/uicp-host@1.0.0.wit†L1-L49】
    - [ ]Validation: add feature-gated tests beside `compute.rs` that open the preopen, attempt escapes, and exercise the host control/rng APIs.
   IntegrationDeterministic seed contract

AC: Job has a stable seed, either JobSpec.jobSeed or seed = SHA256(jobId || envHash), and it is logged and replayed.

- [ ] Backpressure and write quotas

AC: Host enforces per-job quotas on stdout/stderr/logger and partial events, with backpressure, not drops. Defaults: stdout+stderr 256 KiB/s with 1 MiB burst, logger 64 KiB/s, partial events 30/s.

    - [x] Guest export invocation (execution wiring)
    - Host instantiates the component and dispatches `csv#run` / `table#run` via `get_typed_func`, validates inputs, and maps outputs/errors through `finalize_ok_with_metrics()` / `finalize_error()`; see `uicp/src-tauri/src/compute.rs` lines 520-620.【F:uicp/src-tauri/src/compute.rs†L520-L620】
    - Metrics enrichment and partial streaming live in the dedicated checklist items below.

    - [ ] Partial event streaming and guest logs
    - [ ] Align the host/bridge schema: Rust currently defines `ComputePartialEvent { payload_b64 }` while TypeScript expects a `Uint8Array payload`; choose one encoding and update `uicp/src-tauri/src/main.rs`, `uicp/src/compute/types.ts`, and the bridge listener in `uicp/src/lib/bridge/tauri.ts` together.【F:uicp/src-tauri/src/main.rs†L270-L310】【F:uicp/src/compute/types.ts†L41-L69】【F:uicp/src/lib/bridge/tauri.ts†L364-L414】
    - Implement the Preview 2 `streams::output-stream` sink returned by `open_partial_sink` so guest writes produce `compute.result.partial` events and increment `partial_frames` / `invalid_partial_frames`; enforce ordering via `Ctx.partial_seq` and validate payload size/type.【F:uicp/components/csv.parse/src/lib.rs†L11-L60】【F:uicp/src-tauri/src/compute.rs†L252-L259】
    - Capture guest stdout/stderr and the structured logger import, trim payloads, emit `debug-log` telemetry, and bump `invalid_partial_frames` on rejects.
    - Tests: add fixtures that stream valid and malformed CBOR frames, asserting host behavior and metrics.

  - [ ] Metrics finishing pass
    - Extend `collect_metrics()` to record `fuelUsed` (via `Store::get_fuel` once metering is enabled) and `memPeakMb` from `StoreLimits`, alongside existing duration/deadline data.【F:uicp/src-tauri/src/compute.rs†L824-L858】
    - Wire `log_count` increments inside the logger shim, propagate `partialFrames`/`invalidPartialsDropped`, and persist metrics in cache writes (`compute_cache::store`).
    - Emit metrics for terminal error envelopes (`finalize_error`) to keep UI/telemetry parity with success cases.【F:uicp/src-tauri/src/compute.rs†L702-L765】

-------------------------------------------------------------------------------

## 2) App Shell and Orchestration (Rust/Tauri)

- [x] AppState and concurrency
  - Fields for compute in-flight map, cancel map, and semaphore cap

- [x] Commands
  - `compute_call`, `compute_cancel`, `verify_modules`, `clear_compute_cache`, `copy_into_files`, `get_modules_info`

- [x] Cache semantics
  - CA lookups keyed by task+input+env; readOnly vs readwrite policy handled
  - SQLite table enforces `(workspace_id, key)` composite primary key with immutable `created_at`; migration helper `migrate_compute_cache()` rebuilds legacy rows and keeps the latest record per workspace/key.
  - Supporting index `idx_compute_cache_task_env` covers hot `(workspace_id, task, env_hash)` probes; include a regression test ensuring different workspaces cannot clobber each other.
  - Canonicalizer escapes control characters (including U+2028/U+2029); keep regression tests (`canonicalize_escapes_js_separators`, `upsert_scopes_to_workspace_and_preserves_created_at`) green via `cargo test compute_cache` whenever JSON formatting rules change.

- [x] Health/safe-mode
  - DB quick_check and safe-mode toggles; replay telemetry stream

  - [ ] E2E harness for compute
    - Build a deterministic Playwright flow (or Vitest + Tauri harness) that launches the desktop, uploads a tiny CSV fixture, issues `window.uicpComputeCall` for `csv.parse@1.2.0`, waits for `compute.result.final.ok`, and asserts bindings/state updates in the UI store.【F:uicp/src/lib/bridge/tauri.ts†L364-L414】【F:uicp/tests/unit/compute.store.test.ts†L1-L200】
    - Include negative coverage: cancel in-flight job, observe `Compute.Cancelled`, and verify cache hit replay path when running twice with `cache: 'readwrite'`.
    - Gate the test behind a CI label (`npm run test:e2e -- --project compute`) so it can run headless on GitHub Actions once modules are bundled.

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

- [x] UI affordances for compute
  - Compute store tracks duration, cache hits, partial counters (`uicp/src/state/compute.ts:5`), and bridge toasts now map codes via `formatComputeErrorToast` (`uicp/src/lib/bridge/tauri.ts:152`).
  - Metrics panel, Devtools compute panel, and the demo window surface partial frames + cache telemetry with indicator chips and per-job badges.

-------------------------------------------------------------------------------

## 4) Modules and Interface Contract

- [x] Manifest + installer + verifier
  - Files: `uicp/src-tauri/src/registry.rs`, `verify_modules` command, `scripts/update-manifest.mjs`

- [x] Build/publish scripts
  - File: `uicp/package.json` (`modules:build:*`, `modules:update:*`, `modules:verify`)

  - [~] Guest ABI contract
    - World: `world command` exports `csv` and `table` interfaces sharing `common.rows`; lives at `uicp/src-tauri/wit/command.wit` and mirrors component crates under `uicp/components/*`.【F:uicp/src-tauri/wit/command.wit†L1-L25】【F:uicp/components/csv.parse/src/lib.rs†L1-L74】
    - TODO: freeze the ABI by documenting request/response schemas, error semantics, and host imports in `docs/compute/README.md` and a dedicated WIT changelog. Include examples for partial CBOR envelopes and cancellation contracts.
    - TODO: ensure host shims match the WIT files (`uicp:host/control`, `logger`, `rng`, `clock`) and add conformance tests using `wit-bindgen` generated bindings once the host exposes these imports.
    - TODO: add regression tests that diff the checked-in WIT files versus generated TypeScript/Rust bindings (`npm run gen:io`) so drift is caught in CI.

  - [ ] Minimum viable component(s)
    - Build and check in the release WASM binaries for `csv.parse@1.2.0` and `table.query@0.1.0` under `uicp/src-tauri/modules/`, replacing the placeholder digest values in `manifest.json` with actual SHA-256 hashes signed by the build pipeline.【F:uicp/src-tauri/modules/manifest.json†L1-L12】
    - Automate artifact production using `npm run modules:build` + `npm run modules:publish`, ensure outputs are reproducible (document rustc/wasm-opt versions), and store provenance in CHANGELOG or release notes.
    - Extend `scripts/verify-modules.mjs` to enforce signature/digest verification in CI (`STRICT_MODULES_VERIFY=1`) and add a regression test that loads a module via the host and exercises a smoke input.
    - Include sample input/output fixtures so documentation and tests can validate module behavior deterministically.

-------------------------------------------------------------------------------

## 5) Security & Policy

- [x] Capability enforcement in host and call boundary
  - Denied: network by default; strict ws:/ path scoping; timeout/memory caps

- [x] Symlink and traversal protection for workspace files
  - Canonicalization and base-dir prefix assertion

  - [ ] WASI surface hardening
    - Disable ambient authorities: avoid `.inherit_stdio()`, `.inherit_args()`, `.inherit_env()`, and only link the deterministic host shims in `uicp:host`; continue to default-deny `wasi:http` / `wasi:sockets`.【F:uicp/src-tauri/src/compute.rs†L352-L398】【F:docs/wit/uicp-host@1.0.0.wit†L1-L49】
    - Gate any future capability expansion (e.g., net allowlists) behind `ComputeCapabilitiesSpec` checks in `compute_call()` and document policy expectations.
    - Capture a security note in release docs summarizing which WASI imports are enabled by default.

  - [ ] Negative tests
    - Add Rust unit/integration tests that attempt disallowed FS/net/time operations and assert the runtime surfaces `Compute.CapabilityDenied` or `Compute.Resource.Limit`; mirror critical cases through the Tauri command API in TS tests.【F:uicp/src-tauri/src/main.rs†L230-L333】
    - Cover deadline overrun, cancellation grace, and memory exhaustion scenarios to prove the host halts work promptly and emits the correct telemetry.

-------------------------------------------------------------------------------

## 6) Observability

- [x] Structured events
  - `debug-log`, `compute.result.final`, `compute.debug` telemetry; replay telemetry

- [~] Per-task metrics
  - Final Ok envelopes include duration, deadline budget, log/partial counters, and `outputHash`; cache persistence keeps metrics (`uicp/src-tauri/src/compute.rs:842`).
  - TODO: add mem/fuel capture, expose metrics in UI dashboards, and include error-path metrics.

  - [ ] Logs/trace capture
    - Implement the structured logger import so guest `log(level, msg)` calls produce sanitized `debug-log` events and optionally feed a rolling buffer accessible in the UI; enforce rate limits and truncation.
    - Integrate partial stream frames with tracing: attach job/task identifiers and sequence numbers so troubleshooting has sufficient context; redact PII before emission.

-------------------------------------------------------------------------------

## 7) CI/CD and Build Matrix

- [x] Module verification workflow present (`.github/workflows/verify-modules.yml`)

- [~] Compute build jobs
  - `rust-compute-build` CI job runs `cargo check`/`cargo build` with `wasm_compute,uicp_wasi_enable` (`.github/workflows/ci.yml:134`).
  - TODO: add feature-on `cargo test` and integrate Wasm component build smoke.

  - [ ] E2E smoke for compute
    - Add a CI-friendly Playwright job (Linux) that installs the bundled modules, starts the Tauri app in `--headless` or harness mode, submits a known job, and asserts final success/metrics/caching (pairs with the harness item above).
    - Record video/log artifacts for debugging failures; gate merges on this smoke test once it is stable.

-------------------------------------------------------------------------------

## 8) Documentation

- [x] Baseline docs present: `docs/compute/README.md`, host skeleton (`docs/compute/host-skeleton.rs`), WIT draft

- [~] Update docs with:
  - Feature flags + enablement now covered in `docs/setup.md#wasm-compute`; module build/verify flow documented in `docs/compute/README.md`.
  - Error taxonomy captured in `docs/compute/error-taxonomy.md`; compute toasts reference these codes.
  - TODO: add determinism/record-replay guarantees, guest log policy, and UI surfacing guidelines.

-------------------------------------------------------------------------------

## 9) Release Gates (Go/No-Go)

  - [ ] Guest export wiring complete; csv.parse/table.query MVP runs end-to-end locally with partial streaming + metrics captured (see Sections 1 & 3).
  - [ ] WASI imports limited to policy; fs preopens verified to sandbox via automated tests (Section 5) and manual validation with real modules.
  - [ ] Unit + integration + E2E suites green (Rust + TS), including the new compute harness and negative tests.
  - [ ] CI builds with compute features enabled, module verifier strict mode, and WASM artifacts published.
  - [ ] Docs updated; feature flag defaults agreed for release and reflected in README/setup + release notes.

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
