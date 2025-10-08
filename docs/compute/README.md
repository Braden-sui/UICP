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

New dev helpers (repo scripts)

- Build both components:
  - `cd uicp && npm run modules:build`
- Publish artifacts + digests to the dev registry:
  - `cd uicp && npm run modules:publish`
- Verify manifest/file digests:
  - `cd uicp && npm run modules:verify`
- Run desktop with local modules dir:
  - `cd uicp && npm run dev:wasm`

UI demo
- Open the Desktop and click “Compute Demo” to submit sample jobs:
  - csv.parse@1.2.0 → binds to `/tables/demoCsv`
  - table.query@0.1.0 → binds to `/tables/demoQuery`

Metrics (final Ok)

- durationMs, deadlineMs, remainingMsAtFinish
- logCount, partialFrames, invalidPartialsDropped
- fuelUsed (when > 0)
- outputHash (sha256 over canonicalized JSON output)
