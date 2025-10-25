# Compute Runtime: Master Checklist

Purpose: single source of truth for the compute plane (Rust host + TS frontend). Tracks what is done and what remains, with pointers to code. Treat this as an execution plan and review artifact.

Legend

- [x] complete and verified locally (builds/tests pass)
- [ ] pending
- [~] partial/in progress

Last updated: 2025-10-19

- JS/TS: pnpm run test → 314/315 passing (1 pre-existing); pnpm run lint → clean
- Rust: integration suites present; see sections below and testing.md
- Track C (golden cache): Foundation complete; integration pending

-------------------------------------------------------------------------------

## Provider CLI Test Matrix (fast, simulated)

- Fresh machine (no PATH):
  - `health('claude')` with bogus `UICP_CLAUDE_PATH` returns ProgramNotFound and lists search paths.
  - `health('codex')` with PATH pointing at a stub prints version and succeeds.
- Jail ON (httpjail):
  - Login denied surfaces `E-UICP-1504 NetworkDenied`; broadening allowlist (simulated via stub) allows login to succeed.
- macOS keychain locked (simulated):
  - Claude health captures `E-UICP-1503 KeychainLocked` and adds unlock hint text.
- Env override:
  - Setting `UICP_CLAUDE_PATH` to a bogus path produces `ProgramNotFound` and shows all candidate paths tried.
- Install/Update flow:
  - Agent Settings → Code Providers → `Install / Update` (per provider) calls `provider_install` under the hood and re-runs health.

Implementation: unit tests in `uicp/src-tauri/src/provider_cli.rs` create Unix shell stubs and manipulate `PATH`/env to avoid real network/OS dependencies. No external installs run; tests are fast and deterministic.

Run (Rust only): `cargo test -p uicp --lib` (CI runs on Linux). On Windows/macOS, ensure a C toolchain is available for Rust.

-------------------------------------------------------------------------------

## Execution cadence and time expectations

- The agent works iteratively until each checklist item is delivered or explicitly descoped; there is no fixed "timebox" after which execution stops automatically.
- Progress updates will call out blockers, additional context needed, or environment limitations as soon as they are discovered rather than waiting for a deadline.
- If an explicit calendar deadline is required (for example, to align with a release cut), add it to the relevant checklist item so prioritization and sequencing can be adjusted.

## Identifier hygiene

- WIT packages, interfaces, functions, and fields use kebab-case (lowercase words separated by single hyphens). Examples: `uicp:host@1.0.0`, `uicp:task-csv-parse@1.2.0`, `has-header`.
- WIT import version policy: compare on major.minor only to avoid upstream patch drift breaking contracts (e.g., allow any `0.2.x`; encode as `@0.2`).
- Cargo `package.metadata.component` sticks to cargo-component supported keys (`world`, `wit-path`).

-------------------------------------------------------------------------------

## 1) Host Runtime (Rust)

- [x] Feature-gated host scaffolding
  - Files: `uicp/src-tauri/src/compute.rs`, `uicp/src-tauri/Cargo.toml`
  - `wasm_compute` enables Wasmtime; fallback path returns structured error when disabled

- [x] Engine configuration
  - Component model + async + fuel + epoch interruption configured (`build_engine()`)
  - `StoreLimits` attached; memory cap derived from `mem_limit_mb`

- [x] Version pin and upgrade gate
- Current: Wasmtime and wasmtime-wasi are pinned via lockfile to `37.0.2` (Cargo.lock). Preview 2 is in use and supports the newer component encoding (0d 00 01 00). CI enforces pinned versions.
  - CI `Assert Wasmtime versions pinned` step fails if the lockfile drifts from `37.0.x`.

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
  - Emits `debug-log`, `compute-result-final`; caches deterministic payloads when replayable

  - [x] WASI imports
    - Current state: Preview 2 core wiring lives behind `uicp_wasi_enable`; when disabled, `add_wasi_and_host` returns a guidance error instead of silently missing imports.
    - Implemented (host: `uicp/src-tauri/src/compute.rs`):
      - [x] Per-workspace readonly preopen via `WasiCtxBuilder::new().preopened_dir(filesDir, "/ws/files", DirPerms::READ, FilePerms::READ)`; enabled only when `capabilities.fs_read|fs_write` includes `ws:/files/**`. Host helpers still enforce `sanitize_ws_files_path()` and `fs_read_allowed()` for host-mediated reads.
      - [x] Deterministic stdio/log handling: line-buffered WASI stdout/stderr emit `compute-result-partial` log frames with `{ jobId, task, seq, kind:"log", stream, tick, bytesLen, previewB64, truncated }`; increments per-job `log_count`. Mapping `wasi:logging/logging` to structured partials is planned.
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

## 1.5) Track C: Code Generation with Golden Cache (Rust/TypeScript)

- [x] Schema extensions
  - Files: `uicp/src/compute/types.ts`, `uicp/src/lib/schema/index.ts`, `uicp/src/lib/llm/tools.ts`
  - Added `artifactId`, `goldenKey`, `expectGolden` to `JobSpec`; `goldenHash`, `goldenMatched` to metrics

- [x] Frontend executor
  - File: `uicp/src/lib/uicp/adapters/adapter.commands.ts`
  - `createNeedsCodeExecutor` routes `needs.code` operations to compute bridge with Track C metadata

- [x] Prompt guidance
  - Files: `uicp/src/prompts/planner.txt`, `uicp/src/prompts/actor.txt`
  - Documented `needs.code` operation; added linter exception for compute workflows paired with progress UI

- [x] Linter integration
  - File: `uicp/src/lib/uicp/adapters/batchLinter.ts`
  - Added `needs.code` to `VISUAL_OPS` set; batches must pair with progress UI

- [x] Golden cache storage
  - File: `uicp/src-tauri/src/compute_cache.rs`
  - Implemented `compute_output_hash()`, `store_golden()`, `lookup_golden()` functions
  - Database schema: `golden_cache` table with `(workspace_id, key) → (output_hash, task, created_at)`

- [x] Database schema
  - File: `uicp/src-tauri/src/core.rs`
  - Created `golden_cache` table on first launch; workspace-scoped

- [~] Integration into compute execution
  - Pending: Wire `store_golden()` and `lookup_golden()` into `finalize_ok_with_metrics()` in `compute.rs`
  - On golden mismatch: trigger safe mode and emit `replay-issue` event
  - Metrics: populate `goldenHash` and `goldenMatched` fields in final envelope

- [ ] Integration tests
  - Pending: Test golden cache hit/miss/drift scenarios in `integration_compute/` harness

- [ ] UI observability
  - Pending: Surface `goldenMatched` status in Devtools compute panel; add nondeterminism alerts

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
    - CI step `pnpm run test:e2e -- --project compute` wired in `.github/workflows/compute-ci.yml` to run headless on Actions once modules bundle.【F:.github/workflows/compute-ci.yml†L63-L84】

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
  - Compute store tracks duration, cache hits, partial counters (`uicp/src/state/compute.ts`), and bridge toasts now map codes via `formatComputeErrorToast` (`uicp/src/lib/bridge/tauri.ts`).
  - Metrics panel, Devtools compute panel, and the demo window surface partial frames + cache telemetry with indicator chips and per-job badges.

- [x] Applet panels (script.panel)
  - Component wrapper registered; lifecycle orchestrated in adapter v2 (`component.render` path).
  - State keys: `panels.{id}.model` (workspace), `panels.{id}.view` (window), `panels.{id}.config` (workspace).
  - `uicp://compute.call` supports:
    - DIRECT mode: `{ input: { mode: "init"|"render"|"on-event", source?|module? } }` returns data immediately (used for init/event handling).
    - INTO mode: writes sink `{ status, html|error }` to `{scope,key}`; watcher sanitizes/injects HTML.
  - Event bridge: `data-command='{"type":"script.emit","action":"...","payload":{}}'` resolves nearest `.uicp-script-panel`, applies next_state/batch, then re-renders via INTO.

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
    - TODO: add regression tests that diff the checked-in WIT files versus generated TypeScript/Rust bindings (`pnpm run gen:io`) so drift is caught in CI.

- [x] Float determinism guard
  - `compute_cache` canonicalization normalises float representations and rejects non-finite numbers (`serde_refuses_non_finite_numbers`), and `integration_compute/determinism.rs` asserts identical `outputHash` across repeated table.query runs with identical seeds.

- [x] Clock monotonicity and deadline coupling
  - `deadline_remaining_monotonic_nonnegative` in `uicp/src-tauri/src/compute.rs` validates the host clock helpers, and determinism tests ensure deadline instrumentation lines up with final metrics.

- [x] RNG reproducibility
  - Harness tests (`integration_compute/determinism.rs`) prove identical RNG seeds and `fuelUsed` values for matching env hashes; unit tests check `rng_counter` accounting.

  - [x] Minimum viable component(s)
    - Build and check in the release WASM binaries for `csv.parse@1.2.0` and `table.query@0.1.0` under `uicp/src-tauri/modules/`, replacing the placeholder digest values in `manifest.json` with actual SHA-256 hashes signed by the build pipeline.【F:uicp/src-tauri/modules/manifest.json†L1-L12】
    - Automate artifact production using `pnpm run modules:build` + `pnpm run modules:publish`, ensure outputs are reproducible (document rustc/wasm-opt versions), and store provenance in CHANGELOG or release notes.
    - CI verifies manifests and signatures (`scripts/verify-modules.mjs`) and module smoke tests execute real jobs via the harness.

- [~] Mandatory module signatures in release
  - AC: With `STRICT_MODULES_VERIFY=1`, unsigned or mismatched-digest modules refuse to load; CI release job runs with this flag.
  - Status: Partial
    - Enforced at load-path: `registry::find_module` requires a valid Ed25519 signature when `STRICT_MODULES_VERIFY` is truthy, using `UICP_MODULES_PUBKEY` (base64 or hex) for verification. Unsigned or invalid signatures fail fast; digest mismatches already fail via `verify_digest`.
    - Next: wire CI release job with `STRICT_MODULES_VERIFY=1` and `UICP_MODULES_PUBKEY` so unsigned artifacts are rejected automatically.

- [x] Component feature preflight
- `preflight_component_imports` inspects top-level component imports via Wasmtime and compares against per-task allowlists. csv.parse permits the Preview 2 core set exposed by `wasmtime-wasi` (`wasi:cli/{environment,exit,stdin,stdout,stderr}@0.2.3`, `wasi:io/{error,streams}@0.2.3`, `wasi:clocks/wall-clock@0.2.3`, `wasi:filesystem/{preopens,types}@0.2.3`). table.query extends that set with `uicp:host/control@1.0.0`, `uicp:task-table-query/types@0.1.0`, `wasi:clocks/monotonic-clock@0.2.3`, and `wasi:io/error@0.2.8` / `wasi:io/streams@0.2.8`. Violations raise `E-UICP-0230` before instantiation. Tests in `module_smoke.rs` cover allowed and mismatched policies.

-------------------------------------------------------------------------------

## 5) Security & Policy

- [x] Capability enforcement in host and call boundary
  - Denied: network by default; strict ws:/ path scoping; timeout/memory caps

- [x] Symlink and traversal protection for workspace files
  - Canonicalization and base-dir prefix assertion

  - [x] Container firewall + caps controls (provider sandbox)
    - Runtime flags enforced: `--memory`, `--memory-swap`, `--cpus`, `--pids-limit 256`, `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`; tmpfs for `/tmp`, `/var/tmp`, `/run`, `/home/app`.
    - Preferences store exposes toggles: **Disable container firewall** (`UICP_DISABLE_FIREWALL=1`, removes iptables + cap-add) and **Strict capability minimization** (`UICP_STRICT_CAPS=1`, omits `--cap-add` regardless of firewall).
    - `with-firewall.sh` honors `DISABLE_FIREWALL=1` and logs when iptables is skipped; httpjail remains the secondary guard.

  - [x] WASI surface hardening
    - Host builds the component linker without inheriting stdio/args/env, only attaches deterministic shims (`uicp:host/control`, RNG, logging). Import-surface tests assert the linked capabilities, and network/filesystem access remains default-deny.
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
  - `debug-log`, `compute-result-final`, `compute-debug` telemetry; replay telemetry

  - [x] Per-task metrics
  - Final envelopes include duration, cache hit, deadline budget, peak memory, fuel, and throttle counters (`uicp/src/state/compute.ts`). `summarizeComputeJobs` exposes p50/p95 snapshots consumed by Devtools panels and tested in `uicp/tests/unit/compute.summary.test.ts`.

  - [x] Logs/trace capture
    - `wasi:logging/logging` is bridged to structured partial frames with byte throttling (`uicp/src-tauri/src/compute.rs`); Devtools panels render the rolling buffer with tests in `uicp/tests/unit/devtools.compute.panel.test.tsx`.
    - `performance.mark` and `workspace-replay-*` events instrument client-side replay; host spans cover module install, queue execution, and cache writes.

-------------------------------------------------------------------------------

## 7) CI/CD and Build Matrix

- [x] Module verification workflow present (`.github/workflows/verify-modules.yml`)

- [x] Compute build jobs
  - `compute-ci` compiles the host with `wasm_compute,uicp_wasi_enable` and runs `cargo test` for Rust, plus TS unit tests (`.github/workflows/compute-ci.yml`).
  - `Regenerate WIT bindings` runs `pnpm run gen:io` and fails when generated bindings drift from checked-in WIT definitions.
  - Added metadata checks for `components/log.test` to guard interface drift. Next: integrate Wasm component build smoke.
  - JS/TS unit suite green locally (114 tests). Critical adapter/LLM/UI tests listed in section 11.

  - [x] E2E smoke for compute
    - `uicp/tests/e2e/compute.smoke.spec.ts` drives the headless harness (CSV parse success, cache replay delta, cancellation). CI runs it via `pnpm run test:e2e -- --grep "compute harness"` in `.github/workflows/compute-ci.yml`.

- [x] Host-only E2E smoke with `STRICT_MODULES_VERIFY`
  - CI step **Host harness smoke (strict verify)** runs `cargo run --bin compute_harness` against `csv.parse@1.2.0` with `STRICT_MODULES_VERIFY=1` and the published public key, ensuring signed modules execute under strict policy.

-------------------------------------------------------------------------------

## 8) Documentation

- [x] Baseline docs present: `docs/compute/README.md`, host skeleton (`docs/compute/host-skeleton.rs`), WIT draft

- [~] Update docs with:
  - Feature flags + enablement now covered in `docs/USER_GUIDE.md#setup`; module build/verify flow documented in `docs/compute/README.md`.
  - Error taxonomy captured in `docs/compute/error-taxonomy.md`; compute toasts reference these codes.
  - TODO: add determinism/record-replay guarantees, guest log policy, and UI surfacing guidelines.

-------------------------------------------------------------------------------

## 9) Release Gates (Go/No-Go)

- [x] Guest export wiring complete; `integration_compute/module_smoke.rs` exercises `csv.parse@1.2.0` and `table.query@0.1.0` via the harness, asserting success when modules are present.
- [x] WASI imports limited to policy; `integration_compute/import_surface.rs` diffs component imports against allowed surfaces and unit tests assert fs sandbox behaviour.
- Host tests include import-surface assertions and a logging guest component; add import enumeration diff for all bundled modules before release.
- [x] Unit + integration + E2E suites green (Rust + TS), including compute harness, negative execution, determinism, and replay shakedown tests.
- [x] CI builds with compute features enabled, strict signature verification (`STRICT_MODULES_VERIFY`), WIT regeneration, and Playwright harness.
- [x] Docs updated; setup/README/BUILD_MODULES reflect Wasmtime 37 requirements and strict verification flow (see commits 2025-01-14+).

-------------------------------------------------------------------------------

## 10) Nice-to-haves (Post-MVP)

- [ ] Determinism probes for compute outputs and optional golden tests
- [ ] Resource budgets/benchmarks (latency p95 deltas on changed path) — tracked in `docs/PROPOSALS.md` (Perf baselines in CI)
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
  - Tests: `uicp/tests/unit/adapter.replay.test.ts`

- [x] Queue cancel short-circuit
  - Applies `txn.cancel` batch immediately; clears queued work.
  - Tests: `uicp/src/lib/uicp/__tests__/queue-cancel.test.ts`

- [x] Data-command JSON safety and artifact cleanup
  - Recovers misquoted JSON in `data-command`; trims stray JSON tokens from labels; removes bracket-artifact text nodes.
  - Tests: `uicp/tests/unit/cleanup.test.ts`

- [x] WIL lexicon + parse/map contract
  - Templates parse and map to typed ops (e.g., `api.call` yields `url`/`method`).
  - Tests: `uicp/tests/unit/wil/lexicon_and_parse.test.ts`, `uicp/src/lib/wil/templates.extra.test.ts` (where present)

- [x] LLM streaming: event extraction and cancel
  - Extracts JSON/text deltas and tool-calls; aborts active stream on cancel.
  - Tests: `uicp/tests/unit/ollama.extract.test.ts`, `uicp/tests/unit/ollama.cancel.test.ts`

- [x] Logs panel ingest/filter/clear (UI observability)
  - DevtoolsComputePanel processes `ui-debug-log`; supports filters and clear.
  - Tests: `uicp/tests/unit/devtools.compute.panel.test.tsx`

- [x] Orchestrator fallback
  - Falls back to actor-only path when planner fails; validates error surfaces.
  - Tests: `uicp/tests/unit/orchestrator.fallback.test.ts`, `uicp/tests/unit/orchestrator.timeout.test.ts`

Notes

- These tests run in CI via `compute-ci.yml` (JS/TS unit stage). Rust integration tests are covered in Section 7 and testing.md.

