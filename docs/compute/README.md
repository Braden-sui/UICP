UICP Wasm Compute (Docs Index)

- RFC: docs/rfcs/0001-wasm-only-compute-plane.md
- WIT: docs/wit/uicp-host@1.0.0.wit
- Task example WIT: docs/wit/tasks/uicp-task-csv-parse@1.2.0.wit
- Error taxonomy: docs/compute/error-taxonomy.md
- Host skeleton (non-compiling): docs/compute/host-skeleton.rs

Next steps (Phase 0 targets)

- Add TypeScript `JobSpec` and result envelope types alongside Zod schemas.
- Introduce Tauri commands (compute.call, compute.cancel) backed by a stubbed in-memory queue.
- Add Wasmtime + WASI P2 behind a feature flag (host not wired to app yet).
- Build a tiny dashboard view under the devtools panel to list jobs and last errors.

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
