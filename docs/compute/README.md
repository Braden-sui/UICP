UICP Wasm Compute (Docs Index)

- RFC: docs/rfcs/0001-wasm-only-compute-plane.md
- WIT: docs/wit/uicp-host@1.0.0.wit
- Task example WIT: docs/wit/tasks/uicp-task-csv-parse@1.2.0.wit
- Error taxonomy: docs/compute/error-taxonomy.md
- Host runtime (implemented): uicp/src-tauri/src/compute.rs

Next steps (Phase 0 targets)

- Add TypeScript `JobSpec` and result envelope types alongside Zod schemas.
- Introduce Tauri commands (compute.call, compute.cancel) backed by a stubbed in-memory queue.
- Add Wasmtime + WASI P2 behind a feature flag (host not wired to app yet).
- Build a tiny dashboard view under the devtools panel to list jobs and last errors.

Registry (Phase 0 scaffold)

- Manifest path: `<dataDir>/modules/manifest.json` (override with `UICP_MODULES_DIR`)
- Manifest shape:

```
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

- On submit, the host looks up `task@version`, verifies SHA-256 digest matches, and only then executes.
- In v1, a digest mismatch yields `Task.NotFound` and the module is not executed.

Invariants (enforced)

- Never apply partial state from compute: only final Ok results bind into `state.*`.
- Do not auto-delete files under `ws:/files` during recovery or replay.
- Errors are terminal envelopes that persist and replay as errors; never silently drop them.

Telemetry (replay + recovery)

- On recovery operations, record and/or emit:
  - `replay_status`: one of `ok | reindexed | compacted | rolled_back | failed`
  - `failed_reason`: optional, a concise code/message when failed
  - `checkpoint_id`: last known checkpoint identifier (timestamp or row id)
  - `rerun_count`: number of re-run jobs (v1: 0; future: re-enqueue replayables)

Usage (Phase 0 adapter shim)

- Submit a compute job from a batch using `api.call` with an internal scheme:

```
{ "op": "api.call", "params": {
  "method": "POST",
  "url": "uicp://compute.call",
  "body": {
    "jobId": "<uuid>",
    "task": "csv.parse@1.2.0",
    "input": { "source": "ws:/files/sales.csv", "hasHeader": true },
    "bind": [{ "toStatePath": "/tables/sales" }],
    "timeoutMs": 30000,
    "capabilities": {}
  }
}}
```

- The bridge listens for `compute.result.partial` and `compute.result.final`.
- On final ok, it writes the `output` to each `bind[].toStatePath` as workspace `state.set`.

Trap mapping (planned)

- Epoch preemption (deadline reached) → `Compute.Timeout`
- Memory growth denied by StoreLimits → `Compute.Resource.Limit`
- Digest verification failure → `Task.NotFound`
- Capability violations (net outside allowlist, fs outside workspace) → `CapabilityDenied`

Running locally (V1 quick start)

- Build the csv.parse component (requires cargo-component):
  - `cd uicp/components/csv.parse && cargo component build --release -Zunstable-options`
- Copy wasm and update digest in the sample manifest:
  - `node uicp/scripts/update-manifest.mjs --manifest uicp/src-tauri/modules/manifest.json --task csv.parse --version 1.2.0 --wasm uicp/components/csv.parse/target/wasm32-wasi/release/uicp_task_csv_parse.wasm --filename csv.parse@1.2.0.wasm --copy --outdir uicp/src-tauri/modules`
- Point the app to your modules dir at runtime:
  - Typed-only is ON by default. Disable generic path only if needed.
  - Default (typed-only ON): `UICP_MODULES_DIR=$(pwd)/uicp/src-tauri/modules npm run tauri:dev -- --features wasm_compute`
- To allow generic `run` fallback (typed-only OFF): `UICP_COMPUTE_TYPED_ONLY=0 UICP_MODULES_DIR=$(pwd)/uicp/src-tauri/modules npm run tauri:dev -- --features wasm_compute`
- Submit a job from console (DevTools):
  - `window.uicpComputeCall({ jobId: crypto.randomUUID(), task: 'csv.parse@1.2.0', input: { source: 'data:text/csv,foo%2Cbar%0A1%2C2', hasHeader: true }, bind: [{ toStatePath: '/tables/sales' }], provenance: { envHash: 'abc123' } })`

Metrics (final Ok)

- durationMs, deadlineMs, remainingMsAtFinish
- logCount, partialFrames, invalidPartialsDropped
- fuelUsed (when > 0)
- outputHash (sha256 over canonicalized JSON output)
