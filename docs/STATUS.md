# Project Status (Snapshot)

Purpose: one-page, human-readable snapshot of what is Done, In Progress, Next, plus risks and CI health. This page is the entry point for status; deeper, authoritative checklists remain in docs/MVP checklist.md and docs/compute/COMPUTE_RUNTIME_CHECKLIST.md.

Last updated: 2025-10-19

## Summary

- Desktop app (React + Tauri) runs as a desktop-first experience; when opened in a plain browser the UI degrades gracefully instead of crashing, while the Tauri bridge continues to drive native flows.
- Compute plane (Wasmtime, feature-gated) is implemented with registry, cache, and policy; compute harness E2E smoke now runs in CI to guard guest/host drift.
- Track E (JS execution path in WASI) is complete: QuickJS component is signed, host injects bundled sources, integration suite covers init/render/onEvent, counter applet ships as a reference, and docs live in `docs/compute/JS_EXECUTION_PATH.md`.
- CI runs lint, typecheck, unit, e2e, build, security scans, .

## Now (Current Focus)

- Finalize guest ABI contract docs (document host imports + schemas, freeze changelog).
- Implement component feature preflight to reject unsupported Wasm metadata before instantiation.
- Wire compute metrics (p50/p95 duration, cache ratio) into Devtools dashboards and production observability.

## Done (Recently)

Major October 2025 milestones include: batch idempotency system, stream cancellation API, workspace registration guard, telemetry ID tracking, JSON tool calling (production default), error handling refactor, circuit breaker observability, SQLite maintenance, and compute observability improvements.
Track E closed out with docs, tests, and example applet covering the QuickJS execution path end-to-end.

**For complete details**, see [`IMPLEMENTATION_LOG.md`](IMPLEMENTATION_LOG.md).

## In Progress

- Completing guest ABI freeze and WIT documentation drift checks.
- Component metadata preflight & strict signature enforcement for release packaging.
- UI polish for compute dashboards (alerts + charts) fed by new metrics summary.

## Next (Planned)

- Automate WIT binding drift detection directly in CI (failing when `npm run gen:io` produces diffs).
- Add dashboards/alerts for compute success/error rates, cache hit ratio, throttle counters.
- Expand negative guest modules (timeout, OOM) to validate policy end-to-end under Playwright harness.

## Open Bugs/Quirks

- Rust compute build currently fails on `Component::imports` (Wasmtime API drift). Track upstream change or adjust host code before re-enabling `cargo test --features wasm_compute`.
- Windows-only postinstall: safe to run on Linux/macOS; document in setup (done).

## Risks/Blockers

- Cross-platform native binding quirks (Rollup) — mitigated via `ROLLUP_SKIP_NODE_NATIVE` wrapper and postinstall repair on Windows.
- Cloud rate limits — mitigated via per-host circuit breaker and surfaced retry hints.
- Compute is feature-gated; enablement without modules may confuse users — mitigated via Agent Settings + docs.

## Test/CI Health

- UI: lint, typecheck, unit, e2e, build all pass locally when Node 20/npm 10 are used.
- Compute: Rust tests plus compute harness smoke run in CI; local `cargo test --features wasm_compute` currently blocked by Wasmtime API drift (see Open Bugs).
- Link checks: configured via `.lychee.toml`.

## Pointers (Authoritative Lists)

- MVP scope and status: docs/MVP checklist.md
- Compute runtime checklist: docs/compute/COMPUTE_RUNTIME_CHECKLIST.md
- Compute testing (plan/boundary/coverage): docs/compute/testing.md
- Architecture overview: docs/architecture.md
- Model usage and endpoints: docs/model-usage.md, docs/ollama cloud vs. turbo.md

## Working Agreement (lightweight)

- Keep this snapshot accurate; update when you land meaningful changes.
- Treat checklists as the source of truth for acceptance criteria; this page summarizes and links.

