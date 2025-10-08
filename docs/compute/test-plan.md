UICP Compute Shakedown Tests (v1)

1) Kill and replay
- Start a long-running job, kill the app mid-run.
- On restart, replay applies terminal envelope; no re-execution occurs.

2) Timeout and cancel
- Synthetic busy-loop job reaches 30s and terminates with Compute.Timeout.
- User cancel emits Compute.Cancelled within 250 ms and stops execution.

3) Determinism
- Run same (task, input, module, envHash) twice → identical metrics.outputHash and same state ops order.

4) Capability fences
- Attempt network call without cap.net → IO.Denied.
- Attempt fs path outside ws:/… → IO.Denied.

5) Resource abuse
- Allocate beyond mem cap → Compute.Resource.Limit; app remains responsive.

6) Cache poisoning
- Manually flip a byte in cached final → host detects mismatch and recomputes or errors per policy.

7) Redaction
- Structured logs contain no secrets and no absolute paths outside workspace.

8) Cross-platform triplet
- Run the suite on Windows, macOS, Linux with identical outcomes.

Notes
- Determinism tests double-run the same module to assert equality on metrics.outputHash and resulting state binder ops.
- Poisoning tests operate on a test-only cache namespace.
