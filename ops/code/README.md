Phase B-F: Provider Sandboxing, Routing, Validation, Packaging

Purpose
- Containerize code providers (Claude Code, Codex CLI) with default-deny networking.
- Govern jobs with explicit policy (FS scope, tools, network, budgets).
- Validate output (diff path allowlist + AST denylist for JS/TS).
- Assemble JS results for execution via applet.quickjs@0.1.0.
- Add golden cache for deterministic replays and sub-100ms warm starts.

Usage (CLI)
- One-off run: `node ops/code/run-job.mjs --spec path/to/spec.json`
- Dry run (no containers, validates only): `--dry`
- Provider override: `--provider claude|codex`

Artifacts
- providers/claude-cli.yaml — container, entry, defaults
- providers/codex-cli.yaml — container, entry, defaults
- network/allowlist.json — shared allowlist for httpjail + firewall
- policy/job-classes.json — job routing/toolcaps
- lib/*.mjs — orchestrator, providers, validator, assembler

Notes
- Default network: off. httpjail (if present) further restricts egress to explicit hosts and GET/HEAD/OPTIONS.
- On macOS, httpjail is best-effort; prefer Linux in CI/agents.
- Error codes use E-UICP-####. Nonexistent tools or binaries raise typed errors.
