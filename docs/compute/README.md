# UICP Wasm Compute (Docs Index)

## Master Checklist

- See `docs/compute/COMPUTE_RUNTIME_CHECKLIST.md` for the authoritative list of what’s done and what remains (host, UI, modules, CI, docs).
- RFC: `docs/rfcs/0001-wasm-only-compute-plane.md`.
- WIT index: `docs/wit/host/world.wit` (plus vendored WASI packages under `docs/wit/vendor/`).
  - Task example WIT: `uicp/components/csv.parse/csv-parse/wit/world.wit`.
- Error taxonomy: `docs/compute/error-taxonomy.md`.
- Host runtime: `uicp/src-tauri/src/compute.rs`.
- Cache module: `uicp/src-tauri/src/compute_cache.rs`.

## Maintaining the WIT documentation mirror

- Authoritative WIT packages live under `uicp/src-tauri/wit/` and each component crate (for example `uicp/components/csv.parse/csv-parse/wit/world.wit`).
- The `docs/wit/` folder mirrors the public ABI surface for contributors and external readers, including vendored WASI dependencies in `docs/wit/vendor/`.
- When a WIT contract changes, update both the runtime copy and the doc mirror in the same commit, bump `docs/wit/CHANGELOG.md`, and rerun `npm run gen:io` to refresh `uicp/src/compute/types.gen.ts`.
- If upstream WASI packages change, copy the updated `.wit` files into `docs/wit/vendor/` and note the version in the changelog so the documentation stays self-contained.

## Current status (V1)

- TypeScript `JobSpec` + envelopes ship in `uicp/src/compute/types.ts` (Zod schemas and types).
- Tauri commands implemented in `uicp/src-tauri/src/main.rs`:
  - `compute_call(spec: ComputeJobSpec)`.
  - `compute_cancel(job_id)`.
- Wasmtime + WASI Preview 2 host is feature-gated (`wasm_compute`) in `uicp/src-tauri/src/compute.rs`.
- Workspace-scoped cache implemented in `uicp/src-tauri/src/compute_cache.rs`.
- Clear Compute Cache UI is available in `uicp/src/components/AgentSettingsWindow.tsx` (invokes `clear_compute_cache`).
- JavaScript execution path is production-ready: `applet.quickjs@0.1.0` loads bundled sources via `UICP_SCRIPT_SOURCE_B64`, `script.panel` manages state/view keys, integration coverage lives in `uicp/src-tauri/tests/integration_compute/quickjs_applet.rs`, the counter example ships in `examples/counter-applet/`, and `docs/compute/JS_EXECUTION_PATH.md` captures full architecture and constraints.

## Track C: Code Generation with Golden Cache (V2)

- **Purpose**: Support deterministic code generation workflows with bit-exact output verification.
- **Schema**: Extended `JobSpec` with `artifactId`, `goldenKey`, `expectGolden` fields.
- **Frontend**: `needs.code` operation added to envelope schema; executor in `adapter.commands.ts` routes to compute bridge.
- **Backend**: Golden cache functions in `compute_cache.rs` (`store_golden`, `lookup_golden`, `compute_output_hash`).
- **Database**: `golden_cache` table stores SHA-256 hashes per `(workspace_id, key)`.
- **Verification**: On code generation completion, compare output hash against stored golden; mismatch triggers safe mode.
- **Metrics**: `goldenHash` and `goldenMatched` fields propagate through final event to UI for observability.
- **Status**: Foundation complete; integration into `finalize_ok_with_metrics()` pending.

## Guest ABI contract (csv.parse & table.query)

| Task | WIT package | Export | Imports | Notes |
| ---- | ----------- | ------ | ------- | ----- |
| `csv.parse@1.2.0` | `uicp:task-csv-parse@1.2.0` (`components/csv.parse/csv-parse/wit/world.wit`) | `func run(job-id: string, input: string, has-header: bool) -> result<list<list<string>>, string>` | _None_ | Pure parser. Input is a `data:` URI (CSV text). Returns rows or a string error. |
| `table.query@0.1.0` | `uicp:task-table-query@0.1.0` (`components/table.query/wit/world.wit`) | `func run(job-id: string, rows: list<list<string>>, select: list<u32>, where?: record { col: u32, needle: string }) -> result<list<list<string>>, string>` | `uicp:host/control`, `wasi:io/streams`, `wasi:clocks/monotonic-clock` | Relies on host control for partial logging/cancel checks. No filesystem or network imports are linked. |
| `script.*@x.y.z` | `uicp:applet-script@0.1.0` (`src-tauri/wit/script.world.wit`) | `render(state) -> result<string,string>`, `on-event(action,payload,state) -> result<string,string>`, `init() -> result<string,string>` | _None_ | Backed by in-process JS runtime (`script.hello` stub or `applet.quickjs@0.1.0`). Bundled JS must assign exports to `globalThis.__uicpApplet` (use `npm run bundle:applet`). |


Host shims:

- `uicp:host/control` exposes `should_cancel(job)`, `deadline_ms(job)`, `remaining_ms(job)`, and `open_partial_sink(job)` for structured log frames.
- `wasi:logging/logging` is mapped to `compute-result-partial` events with rate limiting.
- `wasi:io/streams` is limited to the stream returned by `open_partial_sink`; no other stdio is linked.
- `wasi:clocks/monotonic-clock` provides a deterministic `now` view—exposed via the host deadline tracker.

Capability guardrails:

- No ambient filesystem (`wasi:filesystem`) or network (`wasi:http`) imports are linked in V1; granting those requires explicit policy updates and new component versions.
- Modules must execute within 30 s by default (`timeoutMs` gate) and 256 MB of linear memory unless `capabilities.longRun` / `capabilities.memHigh` are set.
- The host derives a stable RNG seed per `(jobId, envHash)` and reports it via `metrics.rngSeedHex`; repeated runs with identical inputs must yield identical `outputHash` values.

Error surface:

- Guests return `result<…>`; errors propagate as `ComputeFinalErr` with `code` such as `Compute.Timeout`, `Compute.Resource.Limit`, `Compute.CapabilityDenied`, or `Runtime.Fault`.
- Non-finite numbers (NaN/Inf) are rejected before caching (`compute_cache::canonicalize_input`).
- Partial logs must stay within the byte budgets enforced by the host; overruns are truncated with `partialThrottleWaits`/`logThrottleWaits` metrics.

## Registry (Phase 0 scaffold)

- Manifest path: `<dataDir>/modules/manifest.json` (override with `UICP_MODULES_DIR`).
- Manifest shape:

```json
{
  "entries": [
    {
      "task": "csv.parse",
      "version": "1.2.0",
      "filename": "csv.parse@1.2.0.wasm",
      "digest_sha256": "<hex>",
      "signature": "<optional>"
    }
  ]
}
```

- On submit, the host looks up `task@version`, verifies the SHA-256 digest matches, and only then executes.
- In V1, a digest mismatch yields `Task.NotFound` and the module is not executed.
- Release builds copy bundled modules into the per-user modules directory on first run if missing.

## Invariants (enforced)

- Never apply partial state from compute: only final ok results bind into `state.*`.
- Do not auto-delete files under `ws:/files` during recovery or replay.
- Errors are terminal envelopes that persist and replay as errors; never silently drop them.

## Telemetry (replay + recovery)

- On recovery, record and/or emit:
  - `replay_status`: `ok | reindexed | compacted | rolled_back | failed`.
  - `failed_reason`: optional code/message when failed.
  - `checkpoint_id`: last known checkpoint identifier.
  - `rerun_count`: number of re-run jobs (future replayables).

## Usage (Phase 0 adapter shim)

- Submit a compute job via the Tauri bridge helper (`uicp/src/lib/bridge/tauri.ts`):

```ts
// window.uicpComputeCall(JobSpec)
await (window as any).uicpComputeCall({
  jobId: '<uuid>',
  task: 'csv.parse@1.2.0',
  input: { source: 'ws:/files/sales.csv', hasHeader: true },
  bind: [{ toStatePath: '/tables/sales' }],
  timeoutMs: 30000,
  capabilities: {},
  cache: 'readwrite',
  workspaceId: 'default',
  provenance: { envHash: 'dev' }
});
```

- The bridge listens for `compute-result-partial` and `compute-result-final`.
- On final ok, it writes the `output` to each `bind[].toStatePath` via workspace `state.set`.

### Applet panels (script.panel) — DIRECT vs INTO

UI applets can be integrated in two complementary ways from the frontend:

- DIRECT mode (returns data immediately to the caller):
  - Triggered when `api.call url: "uicp://compute.call"` carries `body.input` with `{ mode, source? | module? }`.
  - Intended for panel applets implementing `init`, `render`, and `onEvent` in JS during development.
  - Returns a result on the `api.call` response path (no bridge event required).
    - `init` → `{ data: { next_state } }`
    - `render` → `{ data: "<html>..." }`
    - `onEvent` → `{ data: { next_state?, batch? } }`

- INTO mode (writes a sink to state and lets a watcher render):
  - Use `params.into = { scope, key, windowId }`.
  - For `uicp://compute.call`, the adapter writes sink shape:
    ```json
    { "status": "loading|ready|error", "html": "<sanitized>", "error": "string" }
    ```
  - A `state.watch` on the same `{scope,key}` updates the DOM via the sanitizer.

Lifecycle for `script.panel`:

- Keys: `panels.{id}.model` (workspace), `panels.{id}.view` (window), `panels.{id}.config` (workspace)
- First render:
  1) Render wrapper `<div class="uicp-script-panel" data-script-panel-id="{id}"></div>`
  2) Install `state.watch` for `viewKey` targeting the wrapper
  3) Call DIRECT `init` → commit `model`
  4) Call INTO `render` with `{ state: model }` → writes `{ status, html|error }` → watcher injects HTML
- Event flow:
  - Buttons inside panel emit `data-command='{"type":"script.emit","action":"...","payload":{}}'`.
  - Delegator resolves `panelId` from nearest `.uicp-script-panel`, calls DIRECT `on-event` with `{action,payload,state}`.
  - If `next_state` present → update `model`, then INTO `render` to refresh `view`.

Safety and guardrails:

- All HTML passes through the sanitizer (`DomApplier`) before touching the DOM.
- Applet DIRECT path is JS-hosted for development only; no ambient FS or network is available through this path.
- WASI applets continue to run via the bridge path (JobSpec) unchanged.

## Trap mapping (planned)

- Epoch preemption (deadline reached) → `Compute.Timeout`.
- Memory growth denied by `StoreLimits` → `Compute.Resource.Limit`.
- Digest verification failure → `Task.NotFound`.
- Capability violations (net outside allowlist, fs outside workspace) → `CapabilityDenied`.

## Running locally (V1 quick start)

### New dev helpers (repo scripts)

- Build both components: `cd uicp && npm run modules:build`.
- Publish artifacts + digests: `cd uicp && npm run modules:publish`.
- Verify manifest/file digests: `cd uicp && npm run modules:verify`.
- Run desktop with local modules dir: `cd uicp && npm run dev:wasm`.

## CI: module verification

- GitHub Actions run a non-strict verify on pushes/PRs touching modules.
- To enforce strict verification in CI, set `STRICT_MODULES_VERIFY=1` in the workflow or environment.

## Composition and validation tools

- Composition: prefer `wac` (WebAssembly Compositions) for composing/validating components and adapters.
  - Install: `cargo install wac-cli`
  - Validate world conformance: `wac targets module.wasm path/to/world.wit`
- Validation: CI uses `wac targets <component.wasm> <world.wit>` to assert each shipped module implements its declared world.

## UI demo

- Open the Desktop and click "Compute Demo" to submit sample jobs:
  - `csv.parse@1.2.0` → binds to `/tables/demoCsv`.
  - `table.query@0.1.0` → binds to `/tables/demoQuery`.

## Metrics (final ok)

- `durationMs`, `deadlineMs`, `remainingMsAtFinish`.
- `logCount`, `partialFrames`, `invalidPartialsDropped`.
- `fuelUsed` (when > 0).
- `rngSeedHex` for determinism probes.
- `logThrottleWaits`, `loggerThrottleWaits`, `partialThrottleWaits` (rate-limit metrics).
- `outputHash` (sha256 over canonicalized JSON output).

## Guest logs and diagnostics

- Desktop renders compute log previews in `uicp/src/components/LogsPanel.tsx` via bridge handler `uicp/src/lib/bridge/tauri.ts`.
  - Partial event shape: `{ jobId, task, seq, kind: 'log', stream, tick, bytesLen, previewB64, truncated, level? }`.
  - UI decodes `previewB64` for line-buffered previews; `truncated` notes per-job caps.
- Set `UICP_WASI_DIAG=1` (or `uicp_wasi_diag=1`) to emit a one-time `wasi_diag` event enumerating mounts/imports at job start.

## Filesystem preopens (policy)

- Host mounts `ws:/files/**` as readonly via `get_paths().filesDir`.
- V1 keeps WASI FS disabled; modules use `data:` URIs. Preopen is scaffolded for typed file access in V2.
- Rules:
  - Readonly only; writes denied.
  - Paths must start with `ws:/`; joins are sanitized to prevent escaping the mount.

## HTTP allowlist (scaffold)

- Default deny: host does not link `wasi:http` unless a capability gate is satisfied.
- Allowlist will mirror `capabilities.net` (hostnames/origins). See RFC 0001 for V2 plan.

## Cache semantics (workspace-scoped)

- `JobSpec.workspaceId` scopes cache reads and writes (default `"default"`).
- Policies:
  - `readwrite`: check cache, execute on miss, then persist final envelope.
  - `readOnly`: serve only if present; miss returns `Runtime.Fault`.
  - `bypass`: skip cache entirely.
- Backend code paths:
  - Reads: `compute_call()` in `uicp/src-tauri/src/main.rs` via `compute_cache::lookup`.
  - Writes: `uicp/src-tauri/src/compute.rs` via `compute_cache::store`.
- Storage:
  - SQLite table `compute_cache` enforces `(workspace_id, key)` primary key.
  - `created_at` immutable; conflicts update metadata and value only. Index `idx_compute_cache_task_env` covers task/env lookups.
  - `migrate_compute_cache()` deduplicates legacy rows by latest `created_at`.
- Canonicalization:
  - `compute_cache::canonicalize_input` escapes control chars (U+2028/U+2029) for stable hashes.
- Clearing cache:
  - Command: `clear_compute_cache(workspace_id?: String)`.
  - UI: Agent Settings → "Clear Cache" (clears `default`).

## Troubleshooting

- See `docs/compute/troubleshooting.md` for errors such as `Task.NotFound`, digest mismatches, and `CapabilityDenied`.

## Drift Guard

- CI workflow `.github/workflows/compute-ci.yml` runs `npm run gen:io` followed by `git diff --exit-code src/compute/types.gen.ts`, ensuring ABI changes stay in sync with generated bindings before merge.
- Preflight validation (`preflight_component_imports`) loads each module with Wasmtime and rejects any import surface outside the allowlist above. Unknown tasks must register their import policy before modules will load.
## Required Methods (Reference)

- See `docs/compute/required-methods.txt` for WASI stream traits required in the current host.
- Example host skeleton: `docs/compute/host-skeleton.rs` (minimal wiring for docs and experiments).

## Upgrades

- Wasmtime 37 notes and validation checklist: `docs/compute/WASMTIME_UPGRADE_STATUS.md`.

