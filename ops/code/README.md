Phase B-F: Provider Sandboxing, Routing, Validation, Packaging

Purpose
- Containerize code providers (Claude Code, Codex CLI) with default-deny networking.
- Govern jobs with explicit policy (FS scope, tools, network, budgets).
- Validate output (diff path allowlist + AST denylist for JS/TS).
- Assemble JS results for execution via applet.quickjs@0.1.0.
- Add golden cache for deterministic replays and sub-100ms warm starts.

Usage (CLI)
- One-off run: `node ops/code/run-job.mjs --spec path/to/spec.json`
- Dry run (no provider exec): add `--dry`
- Assemble only (bundle + validate, cache): add `--assemble-only`
- Apply diffs from provider (after allowlist check): add `--apply`
- Run inside container (docker/podman): add `--container`
- Provider override: `--provider claude|codex`
- Dual-shot (try both, small budget): add `--dual`

Artifacts
- providers/claude-cli.yaml — container, entry, defaults
- providers/codex-cli.yaml — container, entry, defaults
- network/allowlist.json — shared allowlist for httpjail + firewall
- policy/job-classes.json — job routing/toolcaps
- lib/*.mjs — orchestrator, providers, validator, assembler
- images/claude-code/Dockerfile — Claude container (Ubuntu base)
- images/codex-cli/Dockerfile — Codex container (Node base)
- images/common/with-firewall.sh — default‑deny egress allowlist (iptables)

Notes
- Default network: off. httpjail (if present) further restricts egress to explicit hosts and GET/HEAD/OPTIONS.
- On macOS, httpjail is best-effort; prefer Linux in CI/agents.
- Error codes use E-UICP-####. Nonexistent tools or binaries raise typed errors.
- Risk notes recorded when httpjail allowlist is configured but not enforced (e.g., binary missing on host).

Building Images
- Claude: `docker build -t uicp/claude-code:latest ops/code/images/claude-code`
- Codex: `docker build -t uicp/codex-cli:latest ops/code/images/codex-cli`

Firewall Behavior
- ENTRYPOINT runs `with-firewall.sh`: sets OUTPUT default DROP, allows loopback and established flows, then allows TCP 80/443 only to allowlisted host IPs.
- HTTP method filtering is handled by `httpjail` in the orchestrator/wrapper; the firewall cannot enforce HTTP verbs.
- If iptables capabilities are unavailable, it logs and proceeds (httpjail remains the guard).

Diffs & Path Policy
- Provider outputs are scanned for apply_patch blocks (`*** Begin Patch` … `*** End Patch`).
- Changed files are validated against the job class `fsScope` allowlist before any apply.
- Apply uses `git apply --check -` then `git apply -` to modify the working tree.
