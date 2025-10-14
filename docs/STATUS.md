# Project Status (Snapshot)

Purpose: one-page, human-readable snapshot of what is Done, In Progress, Next, plus risks and CI health. This page is the entry point for status; deeper, authoritative checklists remain in docs/MVP checklist.md and docs/compute/COMPUTE_RUNTIME_CHECKLIST.md.

Last updated: please update this header when you change status.

## Summary

- Desktop app (React + Tauri) runs with MOCK mode by default; cloud/local model calls are wired through the Rust backend.
- Compute plane (Wasmtime, feature-gated) is implemented with registry, cache, and policy; compute harness E2E smoke now runs in CI to guard guest/host drift.
- CI runs lint, typecheck, unit, e2e (mock), build, security scans, and link checking.

## Now (Current Focus)

- Stabilize command replay ordering and add regression tests for destroy-before-create/idempotent replay.
- Add Rust tests for `test_api_key` (cloud vs. local) and verify `api-key-status` events.
- Harden compute harness smoke (collect timings, tighten invariants) after initial CI integration.

## Done (Recently)

- Docs alignment: ports, endpoints, keyring migration, provider usage, architecture overview.
- CI hardened: `npm ci --ignore-scripts --no-optional`, Lychee link check via `.lychee.toml`, SBOM, Trivy, Gitleaks.
- Compute: host scaffolding, workspace-scoped cache, registry/digest verify, partial/final events, guest logs to UI, `UICP_WASI_DIAG`.
- WIT bindings drift guard: `npm run gen:io` + diff on `uicp/src/compute/types.gen.ts`.

## In Progress

- Compute negative tests (timeouts, memory caps, fs policy) executed with a real guest module.
- Import-surface assertions for host (deny `wasi:http`/sockets unless gated).
- Devtools polish for compute logs and metrics panels.

## Next (Planned)

- CI: host-only compute strict verify job (build sample component, verify signature/digest, run trivial job, assert output/digest).
- Determinism probes (seeded RNG and logical clock) surfaced in UI and captured in metrics.
- Minimal dashboards/alerts for critical paths (Tier 2+ readiness).

## Open Bugs/Quirks

- Unit test: `adapter.replay` reported failure locally (“expected 3, received 0”). Investigate ordering and idempotency across window lifecycles; add regression tests.
- Windows-only postinstall: safe to run on Linux/macOS; document in setup (done).

## Risks/Blockers

- Cross-platform native binding quirks (Rollup) — mitigated via `ROLLUP_SKIP_NODE_NATIVE` wrapper and postinstall repair on Windows.
- Cloud rate limits — mitigated via per-host circuit breaker and surfaced retry hints.
- Compute is feature-gated; enablement without modules may confuse users — mitigated via Agent Settings + docs.

## Test/CI Health

- UI: lint, typecheck, unit, e2e (mock), build all pass locally when Node 20/npm 10 are used.
- Compute: Rust tests plus compute harness smoke now run in CI; monitor for flakes while fuel/epoch caps stabilize.
- Link checks: configured via `.lychee.toml`.

## Pointers (Authoritative Lists)

- MVP scope and status: docs/MVP checklist.md
- Compute runtime checklist: docs/compute/COMPUTE_RUNTIME_CHECKLIST.md
- Architecture overview: docs/architecture.md
- Model usage and endpoints: docs/model-usage.md, docs/ollama cloud vs. turbo.md

## Working Agreement (lightweight)

- Keep this snapshot accurate; update when you land meaningful changes.
- Treat checklists as the source of truth for acceptance criteria; this page summarizes and links.
