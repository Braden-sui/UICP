UICP Compute Troubleshooting (V1)

Common terminal errors and likely causes

- Task.NotFound
  - Module not registered in manifest or `task@version` mismatch.
  - Module file missing or digest mismatch. Run `pnpm run modules:verify` or use the Agent Settings → Verify Modules button.

- CapabilityDenied
  - `timeoutMs` outside 1000–120000, or >30000 without `capabilities.longRun`.
  - `memLimitMb` outside 64–1024, or >256 without `capabilities.memHigh`.
  - Filesystem paths not workspace-scoped (must start with `ws:/…`).
  - Network policy:
  - UI egress is controlled by the in‑app Network Guard (default‑deny for sensitive endpoints like DoH domains, metadata IPs, and port 853). Configure via `VITE_NET_GUARD_*` envs.
  - Provider egress is disabled unless `UICP_ALLOW_NET=1`. When enabled, provider calls are still constrained by httpjail allowlists.

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
  - Disable wrapper: omit the allowlist config for local runs. Note: host firewall tooling under `ops/` is ops‑only and not executed by the desktop app.
  - Note: on macOS, httpjail and low-level firewalling are best-effort; prefer Linux runners or containerized execution for strict enforcement.

- Firewall skip / iptables capabilities

- Symptom: container logs show `[with-firewall] iptables not found; skipping firewall` or `[with-firewall] DISABLE_FIREWALL=1; skipping firewall`.
- Interpretation:
  - If you explicitly toggled **Disable container firewall** in Agent Settings, the skip is expected. httpjail (if configured) remains the guard.
  - If you did not disable the firewall, the host engine may not grant `NET_ADMIN/NET_RAW` (common on Docker Desktop without privileged mode). Network will run without iptables; rely on httpjail or run on Linux with capabilities.
- Remediation:
  - Enable the firewall by ensuring `UICP_DISABLE_FIREWALL` is unset and the daemon allows `--cap-add NET_ADMIN --cap-add NET_RAW`.
  - To force capability drop even when the firewall is on, set `UICP_STRICT_CAPS=1` (pref option **Strict capability minimization**).
  - Verify DNS allowlist entries by confirming `/etc/resolv.conf` resolvers are reachable; the firewall only allows ports 53/80/443 to resolvers/allowlisted hosts.

Monitor-only tip

- To observe would‑be blocks without enforcing them, set `VITE_NET_GUARD_MONITOR=1` (logs + toasts, no blocking) and optionally `VITE_GUARD_VERBOSE=1` for detailed diagnostics.
