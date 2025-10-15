# Project Status (Snapshot)

Purpose: one-page, human-readable snapshot of what is Done, In Progress, Next, plus risks and CI health. This page is the entry point for status; deeper, authoritative checklists remain in docs/MVP checklist.md and docs/compute/COMPUTE_RUNTIME_CHECKLIST.md.

Last updated: 2025-01-15 (Codex)

## Summary

- Desktop app (React + Tauri) runs with MOCK mode by default; cloud/local model calls are wired through the Rust backend.
- Compute plane (Wasmtime, feature-gated) is implemented with registry, cache, and policy; compute harness E2E smoke now runs in CI to guard guest/host drift.
- CI runs lint, typecheck, unit, e2e (mock), build, security scans, and link checking.

## Now (Current Focus)

- Finalize guest ABI contract docs (document host imports + schemas, freeze changelog).
- Implement component feature preflight to reject unsupported Wasm metadata before instantiation.
- Wire compute metrics (p50/p95 duration, cache ratio) into Devtools dashboards and production observability.

## Done (Recently)

- State & testing foundation documented (`docs/memory.md`, `docs/TEST_PLAN_LEAN.md`); error-handling note updated to match fail-loud behaviour.
- Adapter `data-command` path now throws `E-UICP-301` on malformed/empty payloads; LLM iterator teardown logs `E-UICP-401`.
- Component preflight enforces per-task import allowlists before instantiation (rejects modules importing `wasi:http`/etc).
- Compute observability gaps closed: float canonicalization tests added, RNG/clock determinism proven, host harness smoke runs under `STRICT_MODULES_VERIFY` in CI.
- CI enforces Wasmtime 37 pin and runs headless compute harness + Playwright smoke against signed modules.

## In Progress

- Completing guest ABI freeze and WIT documentation drift checks.
- Component metadata preflight & strict signature enforcement for release packaging.
- UI polish for compute dashboards (alerts + charts) fed by new metrics summary.

## Next (Planned)

- Automate WIT binding drift detection directly in CI (failing when `npm run gen:io` produces diffs).
- Add dashboards/alerts for compute success/error rates, cache hit ratio, throttle counters.
- Expand negative guest modules (timeout, OOM) to validate policy end-to-end under Playwright harness.

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
