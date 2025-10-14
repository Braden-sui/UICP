# Compute Runtime: Master Checklist

Purpose: single source of truth for the compute plane (Rust host + TS frontend). Tracks what is done and what remains, with pointers to code. Treat this as an execution plan and review artifact.

Legend

- [x] complete and verified locally (builds/tests pass)
- [ ] pending
- [~] partial/in progress

Last updated: 2025-10-13

- JS/TS: npm run test → 114/114 passing; npm run lint → clean
- Rust: integration suites present; see sections below and TEST_COVERAGE_SUMMARY.md

-------------------------------------------------------------------------------

## Execution cadence and time expectations

- The agent works iteratively until each checklist item is delivered or explicitly descoped; there is no fixed "timebox" after which execution stops automatically.
- Progress updates will call out blockers, additional context needed, or environment limitations as soon as they are discovered rather than waiting for a deadline.
- If an explicit calendar deadline is required (for example, to align with a release cut), add it to the relevant checklist item so prioritization and sequencing can be adjusted.

## Identifier hygiene

- WIT packages, interfaces, functions, and fields use kebab-case (lowercase words separated by single hyphens). Examples: `uicp:host@1.0.0`, `uicp:task-csv-parse@1.2.0`, `has-header`.
- Pin WIT import versions explicitly (e.g., `wasi:io/streams@0.2.8`, `wasi:clocks/monotonic-clock@0.2.0`).
- Cargo `package.metadata.component` sticks to cargo-component supported keys (`world`, `wit-path`).

-------------------------------------------------------------------------------

## 1) Host Runtime (Rust)

- [x] Feature-gated host scaffolding
  - Files: `uicp/src-tauri/src/compute.rs`, `uicp/src-tauri/Cargo.toml`
  - `wasm_compute` enables Wasmtime; fallback path returns structured error when disabled

- [x] Engine configuration
  - Component model + async + fuel + epoch interruption configured (`build_engine()`)
  - `StoreLimits` attached; memory cap derived from `mem_limit_mb`

- [~] Version pin and upgrade gate
- Current: Wasmtime and wasmtime-wasi are pinned via lockfile to `37.0.2` (Cargo.lock). Preview 2 is in use and supports the newer component encoding (0d 00 01 00). CI enforces pinned versions.
  - Next: Add golden-run gate before allowing engine upgrades.

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

  - [x] WASI imports
    - Current state: Preview 2 core wiring lives behind `uicp_wasi_enable`; when disabled, `add_wasi_and_host` returns a guidance error instead of silently missing imports.
    - Implemented (host: `uicp/src-tauri/src/compute.rs`):
      - [x] Per-workspace readonly preopen via `WasiCtxBuilder::new().preopened_dir(filesDir, "/ws/files", DirPerms::READ, FilePerms::READ)`; enabled only when `capabilities.fs_read|fs_write` includes `ws:/files/**`. Host helpers still enforce `sanitize_ws_files_path()` and `fs_read_allowed()` for host-mediated reads.
      - [x] Deterministic stdio/log handling: line-buffered WASI stdout/stderr emit `compute.result.partial` log frames with `{ jobId, task, seq, kind:"log", stream, tick, bytesLen, previewB64, truncated }`; increments per-job `log_count`. Mapping `wasi:logging/logging` to structured partials is planned.
      - [x] Host shims for `uicp:host/control` (open_partial_sink, should_cancel, deadline_ms, remaining_ms) and `uicp:host/rng` (next_u64, fill). Logical tick is tracked internally for telemetry; guests use standard `wasi:clocks/monotonic-clock`.
      - [x] Diagnostics toggle `UICP_WASI_DIAG=1` (also `uicp_wasi_diag`) emits a one-time `wasi_diag` event with mounts/imports.
      - [x] Deterministic seed contract - AC: job has a stable seed, either `JobSpec.jobSeed` or `SHA256(jobId||envHash)`, logged and replayed.
        - Implemented: host derives `rng_seed = SHA256(jobId|envHash)` and uses it for `uicp:host/rng`.
          - Files: `uicp/src-tauri/src/compute.rs` (`derive_job_seed`, seed wired into `Ctx.rng_seed`).
          - Telemetry: emits `debug-log` event `{ event: "rng_seed", seedHex }` at job start; final metrics include `rngSeedHex` for golden tests.
          - Determinism: replay of the same `(jobId, envHash)` yields identical RNG sequence.
      - [~] Backpressure and write quotas - AC: per-job quotas on stdout/stderr/logger and partial events with backpressure (no drops). Defaults: stdout+stderr 256 KiB/s with 1 MiB burst, logger 64 KiB/s, partial events 30/s.
        - Implemented (host): token-bucket limiters for stdout/stderr (bytes/s), logger (bytes/s), and partial events (events/s) with backpressure. Writes now block in small intervals inside host streams/hostcalls so no drops occur even if guests ignore `check_write()`/`ready()`.
          - Files: `uicp/src-tauri/src/compute.rs` (`RateLimiterBytes`, `RateLimiterEvents`, integrated in `GuestLogStream`, `PartialOutputStream`, and `host_wasi_log`).
          - Implemented (host): bounded UI event queue decouples emission from Tauri bus (`mpsc::channel` + background drain), guaranteeing no drops with backpressure.
          - Metrics: `logThrottleWaits`, `loggerThrottleWaits`, `partialThrottleWaits` surfaced in final envelopes; UI wiring added in `uicp/src/lib/bridge/tauri.ts`, `uicp/src/state/compute.ts`, `uicp/src/components/DevtoolsComputePanel.tsx`, and `uicp/src/components/MetricsPanel.tsx`.
          - Next: tune queue capacity thresholds and add alerts when sustained throttling occurs; integration tests for quotas/backpressure.

    - Validation: add feature-gated tests beside `compute.rs` that open the preopen, attempt escapes, and exercise the host control/rng APIs. (planned)

    - [x] Guest export invocation (execution wiring)
    - Host instantiates the component and dispatches `csv#run` / `table#run` via `get_typed_func`, validates inputs, and maps outputs/errors through `finalize_ok_with_metrics()` / `finalize_error()`; see `uicp/src-tauri/src/compute.rs` lines 520-620.【F:uicp/src-tauri/src/compute.rs†L520-L620】
    - Metrics enrichment and partial streaming live in the dedicated checklist items below.

    - [~] Partial event streaming and guest logs
    - Host schema kept for CBOR partial frames: `ComputePartialEvent { payloadB64 }`. Bridge logs dev info and tolerates this shape.
    - Implemented `open-partial-sink` using Preview 2 `streams.output-stream`; validates CBOR, enforces sequencing/size, and updates `partial_frames` / `invalid_partial_frames`.
    - Implemented stdio/logger capture to structured log partials; UI renders log previews in `LogsPanel` via `compute_log` UI debug events.【F:uicp/src/lib/bridge/tauri.ts】【F:uicp/src/components/LogsPanel.tsx】
    - Tests: add fixtures that stream valid/malformed CBOR and interleaved stdio ordering. (planned)

  - [x] Metrics finishing pass
    - Implemented: `collect_metrics()` now records `fuelUsed` (when fuel metering enabled) and `memPeakMb` via a custom resource limiter that tracks peak memory growth; existing duration/deadline data preserved.
    - Implemented: `logCount`, `partialFrames`, `invalidPartialsDropped`, and throttle wait counters are propagated and persisted in cache writes.
    - Implemented: error-path metrics included in terminal error envelopes and bridged to UI; frontend schemas updated to parse error metrics and store them.

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

  - [x] E2E harness for compute
    - Implemented Playwright `compute` project that spawns the new `compute_harness` binary (Cargo `run --features compute_harness`). Exercises `window.uicpComputeCall`, asserts store bindings via exposed test hooks, verifies cancellation and cache replay against the real Tauri host.【F:uicp/src/lib/bridge/tauri.ts†L13-L195】【F:uicp/tests/e2e/compute.smoke.spec.ts†L1-L189】【F:uicp/playwright.config.ts†L26-L44】
    - Negative coverage presently covers cancellation and cache replay; timeout/OOM fixtures remain blocked pending a buildable stress module (see notes).
    - CI step `npm run test:e2e -- --project compute` wired in `.github/workflows/compute-ci.yml` to run headless on Actions once modules bundle.【F:.github/workflows/compute-ci.yml†L63-L84】

- [x] Concurrency cap enforcement test
  - AC: With cap `N = 2`, tokio integration test drives real module execution, asserts queue wait metrics via `queueMs`, and proves third job queues while the first two run.【F:uicp/src-tauri/src/main.rs†L262-L286】【F:uicp/src-tauri/src/compute.rs†L920-L1816】【F:uicp/src-tauri/tests/integration_compute/concurrency_cap.rs†L1-L121】

- [x] Kill-and-replay shakedown
  - AC: Restart-aware harness reuses the same data dir, reruns identical job, compares `metrics.outputHash`, ensures cache hit, and checks workspace files for orphans.【F:uicp/src-tauri/src/main.rs†L215-L344】【F:uicp/src-tauri/tests/integration_compute/kill_replay_shakedown.rs†L1-L74】

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
    - World: `task` exports the pure csv interface from `uicp/components/csv.parse/csv-parse/wit/world.wit`; `table.query` retains host-control imports as documented in `uicp/components/table.query/wit/world.wit`.
    - TODO: freeze the ABI by documenting request/response schemas, error semantics, and host imports in `docs/compute/README.md` and a dedicated WIT changelog.
    - TODO: ensure host shims match the WIT files (csv: no imports; table.query: `uicp:host/control`, `wasi:logging`, `wasi:io`, `wasi:clocks`) and add conformance tests using `wit-bindgen` generated bindings once the host exposes these imports.
    - TODO: add regression tests that diff the checked-in WIT files versus generated TypeScript/Rust bindings (`npm run gen:io`) so drift is caught in CI.

- [ ] Float determinism guard
  - AC: Golden test runs the same module on x86_64 and aarch64, exercises NaN/Inf paths, and `outputHash` matches bit-for-bit; test fails on drift.

- [ ] Clock monotonicity and deadline coupling
  - AC: `clock.now_ms` is monotonic per job and never exceeds `control.deadline_ms`; `remaining_ms` hits 0 before the host hard-stops the job.

- [ ] RNG reproducibility
  - AC: For a fixed seed, three consecutive `rng.next_u64` sequences match across two separate runs; `rng_counter` increments are reflected in metrics.

  - [ ] Minimum viable component(s)
    - Build and check in the release WASM binaries for `csv.parse@1.2.0` and `table.query@0.1.0` under `uicp/src-tauri/modules/`, replacing the placeholder digest values in `manifest.json` with actual SHA-256 hashes signed by the build pipeline.【F:uicp/src-tauri/modules/manifest.json†L1-L12】
    - Automate artifact production using `npm run modules:build` + `npm run modules:publish`, ensure outputs are reproducible (document rustc/wasm-opt versions), and store provenance in CHANGELOG or release notes.
    - Extend `scripts/verify-modules.mjs` to enforce signature/digest verification in CI (`STRICT_MODULES_VERIFY=1`) and add a regression test that loads a module via the host and exercises a smoke input.
    - Include sample input/output fixtures so documentation and tests can validate module behavior deterministically.

- [~] Mandatory module signatures in release
  - AC: With `STRICT_MODULES_VERIFY=1`, unsigned or mismatched-digest modules refuse to load; CI release job runs with this flag.
  - Status: Partial
    - Enforced at load-path: `registry::find_module` requires a valid Ed25519 signature when `STRICT_MODULES_VERIFY` is truthy, using `UICP_MODULES_PUBKEY` (base64 or hex) for verification. Unsigned or invalid signatures fail fast; digest mismatches already fail via `verify_digest`.
    - Next: wire CI release job with `STRICT_MODULES_VERIFY=1` and `UICP_MODULES_PUBKEY` so unsigned artifacts are rejected automatically.

- [ ] Component feature preflight
  - AC: Before instantiation, host inspects component metadata and rejects unsupported features with a precise error code and message.

-------------------------------------------------------------------------------

## 5) Security & Policy

- [x] Capability enforcement in host and call boundary
  - Denied: network by default; strict ws:/ path scoping; timeout/memory caps

- [x] Symlink and traversal protection for workspace files
  - Canonicalization and base-dir prefix assertion

  - [ ] WASI surface hardening
    - Disable ambient authorities: avoid `.inherit_stdio()`, `.inherit_args()`, `.inherit_env()`, and only link the deterministic host shims in `uicp:host`; continue to default-deny `wasi:http` / `wasi:sockets`.【F:uicp/src-tauri/src/compute.rs†L352-L398】【F:docs/wit/host/world.wit†L1-L49】
    - Gate any future capability expansion (e.g., net allowlists) behind `ComputeCapabilitiesSpec` checks in `compute_call()` and document policy expectations.
    - Capture a security note in release docs summarizing which WASI imports are enabled by default.

  - [~] Deny-by-default WASI surface
  - AC: Context builder proves no ambient stdio/args/env are inherited; no sockets or `wasi:http` linked in V1; policy test fails if any new caps appear.
  - Status: Partial
    - Tests added:
      - `uicp/src-tauri/src/compute.rs` unit tests assert `add_wasi_and_host` fails when `uicp_wasi_enable` is disabled and succeeds when enabled.
      - `uicp/src-tauri/src/compute.rs` import-surface test asserts `wasi:http/*` and `wasi:sockets/*` are not linked.
    - Next: component-level differential test to enumerate imports of a sample guest and compare against policy.

  - [~] Negative tests
    - Added policy-level denials for out-of-range `timeoutMs`, `memLimitMb`, and non-workspace FS paths; see `uicp/src-tauri/tests/integration_compute/negative_execution.rs` and unit tests in `uicp/src-tauri/src/compute.rs`.
    - Next: add guest-executed WASI attempts (net/time/fs) to assert `Compute.CapabilityDenied`/`Compute.Resource.Limit` and verify telemetry on deadline overrun/cancellation/memory exhaustion.

-------------------------------------------------------------------------------

## 6) Observability

- [x] Structured events
  - `debug-log`, `compute.result.final`, `compute.debug` telemetry; replay telemetry

  - [~] Per-task metrics
  - Final Ok envelopes include duration, deadline budget, log/partial counters, and `outputHash`; cache persistence keeps metrics (`uicp/src-tauri/src/compute.rs:842`).
  - Update: mem/fuel capture and error-path metrics implemented; remaining work is UI polish and additional dashboards/tests.

  - [~] Logs/trace capture
    - Implemented: `wasi:logging/logging` bridged to structured `compute.result.partial` log frames with `{ jobId, task, seq, kind:"log", stream:"wasi-logging", level, context, tick, bytesLen, previewB64, truncated }`. Per-job byte budgets and rate limits applied. Mirrored as `debug-log` with `compute_guest_log` for dev visibility.
  - UI: DevtoolsComputePanel renders a bounded rolling log with jobId/level filters and a Clear button (via `ui-debug-log` bus). LogsPanel shows a larger view. Tests cover panel ingestion, filtering, and clearing.
  - Next: add an integration test with a guest component invoking `wasi:logging` and assert UI entries; ensure memory caps enforced.

-------------------------------------------------------------------------------

## 7) CI/CD and Build Matrix

- [x] Module verification workflow present (`.github/workflows/verify-modules.yml`)

- [x] Compute build jobs
  - `compute-ci` compiles the host with `wasm_compute,uicp_wasi_enable` and runs `cargo test` for Rust, plus TS unit tests (`.github/workflows/compute-ci.yml`).
  - `Regenerate WIT bindings` runs `npm run gen:io` and fails when generated bindings drift from checked-in WIT definitions.
  - Added metadata checks for `components/log.test` to guard interface drift. Next: integrate Wasm component build smoke.
  - JS/TS unit suite green locally (114 tests). Critical adapter/LLM/UI tests listed in section 11.

  - [ ] E2E smoke for compute
    - Add a CI-friendly Playwright job (Linux) that installs the bundled modules, starts the Tauri app in `--headless` or harness mode, submits a known job, and asserts final success/metrics/caching (pairs with the harness item above).
    - Record video/log artifacts for debugging failures; gate merges on this smoke test once it is stable.

- [ ] Host-only E2E smoke with `STRICT_MODULES_VERIFY`
  - AC: CI builds a sample component, verifies signature, loads it in the host, runs a trivial preopen read-write job, and asserts the expected output file and digest.

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
- Host tests include import-surface assertions and a logging guest component; add import enumeration diff for all bundled modules before release.
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
- Tests: `uicp/tests/unit/compute.store.test.ts`, Rust unit tests in `compute.rs`, integration suite under `uicp/src-tauri/tests/integration_compute/*`
- Work-in-progress WIT: `uicp/src-tauri/wit/command.wit`, `docs/wit/host/world.wit`

-------------------------------------------------------------------------------

## 11) Frontend (TS) Validation — Backed by Tests

- [x] Replay ordering and window lifecycle
  - Guarantees destroy-before-create for same window id; DOM ops apply after create.
  - Tests: `uicp/tests/unit/adapter.replay.test.ts:1`

- [x] Queue cancel short-circuit
  - Applies `txn.cancel` batch immediately; clears queued work.
  - Tests: `uicp/src/lib/uicp/__tests__/queue-cancel.test.ts:1`

- [x] Data-command JSON safety and artifact cleanup
  - Recovers misquoted JSON in `data-command`; trims stray JSON tokens from labels; removes bracket-artifact text nodes.
  - Tests: `uicp/tests/unit/cleanup.test.ts:1`

- [x] WIL lexicon + parse/map contract
  - Templates parse and map to typed ops (e.g., `api.call` yields `url`/`method`).
  - Tests: `uicp/tests/unit/wil/lexicon_and_parse.test.ts:1`, `uicp/src/lib/wil/templates.extra.test.ts` (where present)

- [x] LLM streaming: event extraction and cancel
  - Extracts JSON/text deltas and tool-calls; aborts active stream on cancel.
  - Tests: `uicp/tests/unit/ollama.extract.test.ts:1`, `uicp/tests/unit/ollama.cancel.test.ts:1`

- [x] Logs panel ingest/filter/clear (UI observability)
  - DevtoolsComputePanel processes `ui-debug-log`; supports filters and clear.
  - Tests: `uicp/tests/unit/devtools.compute.panel.test.tsx:1`

- [x] Orchestrator fallback
  - Falls back to actor-only path when planner fails; validates error surfaces.
  - Tests: `uicp/tests/unit/orchestrator.fallback.test.ts:1`, `uicp/tests/unit/orchestrator.timeout.test.ts:1`

Notes

- These tests run in CI via `compute-ci.yml` (JS/TS unit stage). Rust integration tests are covered in Section 7 and TEST_COVERAGE_SUMMARY.md.
