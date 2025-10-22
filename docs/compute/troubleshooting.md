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

Provider CLI and httpjail

- No CLI found on PATH
  - Symptom: health check toast mentions the CLI is missing, or provider commands fail with a spawn error.
  - Verify in a terminal: `codex --version` (Codex) or `claude -p ping --output-format json` (Claude).
  - Install the provider CLI per the provider’s docs and ensure the binary (`codex` or `claude`) is on your PATH. Restart your terminal after install.
  - In Agent Settings, use "Check Codex" or "Check Claude" to re-verify.

- CLI installed but not logged in
  - Symptom: login fails or health check returns an error even though the CLI exists.
  - Run the provider login in a terminal: `codex login` or `claude login` and follow prompts.
  - Environment keys also work: Codex reads `OPENAI_API_KEY`; Claude reads `ANTHROPIC_API_KEY`.
  - Re-run the health check from Agent Settings.

- httpjail unavailable
  - Symptom: logs show "httpjail not found on PATH"; local runs proceed without the HTTP allowlist wrapper.
  - Install: place an `httpjail` binary on PATH (for example `/usr/local/bin/httpjail` or `/opt/homebrew/bin/httpjail`). Container images can also fetch it via `HTTPJAIL_URL` during build.
  - Disable wrapper: omit the allowlist config for local runs, or run with `--container` to enforce network policy at the firewall instead.
  - Note: on macOS, httpjail and low-level firewalling are best-effort; prefer Linux runners or containerized execution for strict enforcement.
