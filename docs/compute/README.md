UICP Wasm Compute (Docs Index)

- RFC: docs/rfcs/0001-wasm-only-compute-plane.md
- WIT: docs/wit/uicp-host@1.0.0.wit
- Task example WIT: docs/wit/tasks/uicp-task-csv-parse@1.2.0.wit
- Error taxonomy: docs/compute/error-taxonomy.md
- Host runtime (implemented): uicp/src-tauri/src/compute.rs
- Cache module (implemented): uicp/src-tauri/src/compute_cache.rs

Current status (V1)

- TypeScript `JobSpec` + envelopes ship in `uicp/src/compute/types.ts` (Zod schemas and types).
- Tauri commands implemented in `uicp/src-tauri/src/main.rs`:
  - `compute_call(spec: ComputeJobSpec)`
  - `compute_cancel(job_id)`
- Wasmtime + WASI Preview 2 host is feature-gated (`wasm_compute`) in `uicp/src-tauri/src/compute.rs`.
- Workspace-scoped cache implemented in `uicp/src-tauri/src/compute_cache.rs`.
- Clear Compute Cache UI is available in `uicp/src/components/AgentSettingsWindow.tsx` (invokes `clear_compute_cache`).

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
- Bundled modules in release builds are copied into the per-user modules directory on first run if missing.

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

- Submit a compute job via the Tauri bridge helper (defined in `uicp/src/lib/bridge/tauri.ts`):

```
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

CI: module verification
- A GitHub Actions workflow runs a non-strict verify on pushes/PRs that touch modules.
- To enforce strict verification in CI, set `STRICT_MODULES_VERIFY=1` in the workflow or environment.

UI demo
- Open the Desktop and click “Compute Demo” to submit sample jobs:
  - csv.parse@1.2.0 → binds to `/tables/demoCsv`
  - table.query@0.1.0 → binds to `/tables/demoQuery`

Metrics (final Ok)

- durationMs, deadlineMs, remainingMsAtFinish
- logCount, partialFrames, invalidPartialsDropped
- fuelUsed (when > 0)
- outputHash (sha256 over canonicalized JSON output)

Filesystem preopens (policy)

- The host preps a workspace-scoped readonly mount for the guest: `ws:/files/**` maps to the per-user files directory reported by `get_paths().filesDir`.
- In V1, the WASI FS is kept OFF by default; modules use `data:` URIs. The preopen is scaffolded for V2 and will be enabled together with typed file access.
- Rules:
  - Readonly only; writes are denied.
  - Paths must be workspace-scoped (start with `ws:/`). Joins are sanitized to prevent escaping the mount.

HTTP allowlist (scaffold)

- Default deny. The host does not link `wasi:http` unless a future capability gate is satisfied.
- The allowlist shape will mirror `capabilities.net` (hostnames or origins). See RFC 0001 for V2 plan.

Cache semantics (workspace-scoped)

- `JobSpec.workspaceId` scopes all cache reads and writes. Default is `"default"` when omitted.
- Policies:
  - `readwrite`: check cache, execute on miss, then write final envelope
  - `readOnly`: serve only if present; miss returns `Runtime.Fault` terminal envelope
  - `bypass`: do not read or write cache
- Backend code paths:
  - Reads: `uicp/src-tauri/src/main.rs` in `compute_call()` via `compute_cache::lookup(app, workspace_id, key)`
  - Writes: `uicp/src-tauri/src/compute.rs` via `compute_cache::store(app, workspace_id, key, ...)`
- Clearing cache:
  - Command: `clear_compute_cache(workspace_id?: String)` in `uicp/src-tauri/src/main.rs`
  - UI: Agent Settings → "Clear Cache" (clears for `default` workspace)

Troubleshooting

- See docs/compute/troubleshooting.md for common errors such as `Task.NotFound`, digest mismatches, and `CapabilityDenied`.
