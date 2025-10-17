Integration Tests (Compute + Replay)

Goals

- Exercise end-to-end flows across frontend adapter, Tauri host, DB, and events.
- Verify compute plane contracts (partials, finals, bindings) and replay determinism.

Scenarios

1) Compute success
- Submit a compute job (stub or real) via `uicp://compute.call`.
- Expect one or more `compute-result-partial` events and a final Ok.
- Verify state bindings wrote the output to the workspace store.

2) Timeout & cancel
- Submit a long-running job; expect final `Compute.Timeout` around 30s.
- Cancel a job; expect `Compute.Cancelled` within 250 ms grace.

3) Memory limit
- Run a mem hog; expect `Compute.Resource.Limit` and app remains responsive.

4) Replay
- Apply a batch that mutates state and windows; verify checkpoints written.
- Restart and replay; expect log-order application, last-write-wins, and identical state.

5) Recovery (Safe Mode)
- Corrupt the DB in a controlled test namespace; ensure `quick_check` fails and Safe Mode is entered.
- Run `recovery_auto` and assert telemetry fields and resolution outcomes.

Notes

- Use a dedicated test workspace (DB path override) to avoid clobbering dev data.
- Seed RNG and logical clock when the Wasm runtime is enabled to stabilize outputs.
