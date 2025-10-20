UICP Compute Troubleshooting (V1)

Common terminal errors and likely causes

- Task.NotFound
  - Module not registered in manifest or `task@version` mismatch.
  - Module file missing or digest mismatch. Run `pnpm run modules:verify` or use the Agent Settings → Verify Modules button.

- CapabilityDenied
  - `timeoutMs` outside 1000–120000, or >30000 without `capabilities.longRun`.
  - `memLimitMb` outside 64–1024, or >256 without `capabilities.memHigh`.
  - Filesystem paths not workspace-scoped (must start with `ws:/…`).
  - Network disabled in V1 (HTTP allowlist is default-deny and not yet enabled).

- Resource.Limit
  - Fuel or memory/table limits exceeded. Consider lowering input size or increasing limits with appropriate caps.

- Runtime.Fault
  - Guest trap or panic. Check `compute.host.log` entries and module stderr logs.

Hints

- Use the Metrics panel to view cache hit ratio and p50/p95 latency. Export recent job telemetry as JSON for diagnostics.
- The workspace files directory is shown by the `get_paths` command under `filesDir`. Only `ws:/files/**` is eligible for read-only access in V2.

