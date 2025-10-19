# Proposals (Potential Future Work)

Last updated: 2025-01-19

Purpose
- Collect potential future work across the stack. This is a non-committal backlog for ideas that might graduate into STATUS or RFCs.
- Keep items short, testable, and tied to acceptance checks.

How To Propose
- Title: concise and imperative.
- Problem: why it matters.
- Proposal: the smallest change that solves it.
- Impact: 1..5
- Irreversibility: 1..5
- Confidence: 1..5
- Tier: T0..T4 (use R = (impact * irreversibility) / confidence)
- Risks and mitigations
- Acceptance tests
- Rollback plan

Relationship To Other Docs
- STATUS.md: snapshot of active work. Move items there when prioritized.
- IMPLEMENTATION_LOG.md: record of landed changes. Link proposals when completed.
- RFCs under docs/rfcs: use for design that benefits from review.

Guidelines
- ASCII only. No smart quotes or em dashes.
- Every proposal lists at least one acceptance test.
- When a proposal is accepted, open an issue or PR with a PLAN per the repo guidelines.

---

UI and Adapter
- Docs consistency test in CI
  - Problem: docs can drift from code.
  - Proposal: add a fast Vitest that asserts sanitizer forbids form/input/select, DomApplier sanitizes and errors on missing targets, and txn.cancel semantics. Also check that paths referenced in docs exist.
  - Acceptance: CI fails if claims become false.
- Data-command ergonomics
  - Proposal: optional helper to attach a JSON batch to buttons via a small builder API.
  - Acceptance: component.render(button) example covered in tests.
- DOM apply metrics
  - Proposal: emit adapter.dom.apply histogram fields (applied, skipped, mode) for dashboards.
  - Acceptance: telemetry events present and asserted in tests.

- Long‑run task UX
  - Problem: Background/long tasks lack clear scheduling/progress affordances.
  - Proposal: add scheduling API + progress UI and off‑main signaling for long tasks.
  - Acceptance: E2E demonstrates progress UI and responsive UI during long‑run task.

Planner and Actor
- Two phase planner guardrails
  - Proposal: enforce budget and truncation rules with unit tests for edge windows.
  - Acceptance: failing tests added first, then pass after change.
- Clarifier improvements
  - Proposal: add richer field types (checkbox, number) with strict validation.
  - Acceptance: clarifier UI tests cover new types and JSON output shape.

Compute Plane
- Stdout capture decision
  - Proposal: either implement preview2 stdout/stderr adapter or remove dead helpers and rely on wasi:logging.
  - Acceptance: decision logged, tests adjusted, Windows build stable.
- Bindgen vs manual logging shim
  - Proposal: evaluate using a minimal inline WIT string for logging bindgen.
  - Acceptance: host compiles and integration tests pass.
- HTTP allowlist and FS preopens
  - Proposal: wire typed allowlist and readonly preopens as first class capabilities.
  - Acceptance: integration tests prove denials and allows.

- Module registry signing
  - Problem: Manifest and artifacts lack signature verification.
  - Proposal: add signatures to manifest entries and verify at load; document trust roots.
  - Acceptance: signed manifest verified in CI and at runtime; negative test fails on tamper.

- Python shared runtime on Wasm
  - Problem: Some data‑science workflows prefer Python; no componentized Python core yet.
  - Proposal: evaluate a componentized Python core with Preview 2 bindings for constrained tasks.
  - Acceptance: prototype module runs under Wasmtime; policy guards and tests in place.

Persistence and Replay
- Command log compaction and checkpoints
  - Proposal: periodic compaction with a recoverable checkpoint per workspace.
  - Acceptance: integration tests for replay after compaction.
- Snapshot and restore tool
  - Proposal: export/import a workspace snapshot for bug reports.
  - Acceptance: round trip test preserves windows and state.

- Schema version coverage
  - Problem: Only compute_cache is versioned; other components drift unnoticed.
  - Proposal: add schema_version rows for workspace, tool_call, etc.
  - Acceptance: migration applies and version table shows entries; tests cover drift.

- Automatic migration rollback
  - Problem: Failed migrations require manual steps.
  - Proposal: transactional rollback with recovery note on failure.
  - Acceptance: simulated failure triggers rollback; DB integrity verified.

Observability
- Dashboards and alerts
  - Proposal: add basic dashboards for adapter apply success, error rates, and p95 latency, with at least one alert.
  - Acceptance: links added to docs and CI emits sample events in dev.

- VACUUM duration histogram
  - Problem: Maintenance cost visibility is limited.
  - Proposal: add telemetry histogram around VACUUM and checkpoint durations.
  - Acceptance: metrics emitted and visible; tests assert event shape.

Security and Supply Chain
- Dependency review and pinning
  - Proposal: periodic dependency bump with SAST and SBOM refresh.
  - Acceptance: CI jobs for SAST and SBOM green.
- Secret hygiene
  - Proposal: expand secret scan patterns and add pre-commit hook guidance.
  - Acceptance: secrets blocked in CI.

Performance
- Batch coalescing
  - Proposal: coalesce consecutive dom.set operations per window in the queue.
  - Acceptance: microbenchmark shows reduced applies without correctness loss.
- UI virtualization of long message lists
  - Proposal: virtualize DockChat message list when count exceeds a threshold.
  - Acceptance: render time and memory usage within budget in tests.

- Prompt size budgets
  - Problem: Prompt payloads can exceed target limits and regress silently.
  - Proposal: enforce size budgets (target 16 KB, hard cap 32 KB) with tests; CI guard that fails on over‑budget prompts.
  - Acceptance: unit tests cover truncation rules; CI fails on budget regression.

- Perf baselines in CI
  - Problem: Performance regressions go unnoticed until late.
  - Proposal: add a lightweight CI job that runs a targeted microbenchmark set and asserts p95 delta ≤ 5% vs baseline.
  - Acceptance: CI job reports p50/p95 and fails when deltas exceed thresholds.

Observability (Performance)
- Compare adapters/per‑version
  - Problem: Hard to attribute perf changes to specific versions.
  - Proposal: emit and visualize adapter_version and per‑op histograms (DOM apply, queue latency) to compare baseline vs. head.
  - Acceptance: dashboard shows side‑by‑side p50/p95 across versions; tests assert event fields.

Developer Experience
- Archive normalization tool
  - Proposal: script to move dated docs into docs/archive/YYYY-MM and update links.
  - Acceptance: dry run mode reports planned moves; link check passes after move.
- CLI helpers
  - Proposal: small CLI to scaffold docs with the required headers and fields.
  - Acceptance: created docs pass link and style checks.

- Manual maintenance trigger
  - Problem: Hard to trigger DB maintenance in dev.
  - Proposal: expose a guarded command or env to force a maintenance run.
  - Acceptance: command runs in dev; integration test asserts no‑op in prod mode.
- Javy AOT and AST normalization


