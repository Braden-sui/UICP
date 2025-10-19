# Compute Testing (Consolidated)

Last updated: 2025-01-19

Purpose
- Single, canonical reference for compute testing: plans, boundaries, coverage, and recent fixes.
- Supersedes the separate files previously used for these topics.

Scope
- Test plan and layers (unit, integration, e2e, negative)
- Runtime boundary and invariants
- Coverage summary and gaps
- Recent fixes and regressions caught

Reading Order
1) Plan and layers
2) Runtime boundary and invariants
3) Coverage summary
4) Recent fixes

Plan and Layers
- Unit: pure logic where possible; no Wasm engine
- Contract: public shapes, envelope schemas, and adapters
- Integration: service boundaries (adapter <-> Tauri host, cache, replay)
- E2E: critical journeys only; stable and minimal
- Negative: invalid inputs, timeouts, partial failures; assert loud failure and error codes

Runtime Boundary and Invariants
- Adapter applies only sanitized HTML; no inline JS
- dom.set targets must exist (use window #root when in doubt)
- txn.cancel clears state and closes windows; no partial state binding from compute paths
- Replay never reorders commands; destroy-before-create must be authored

Coverage Summary
- Keep coverage summaries here; do not create new standalone coverage docs

Recent Fixes
- Keep a rolling window here; older entries move to the archive

Sources (superseded)
- docs/compute/TEST_COVERAGE_SUMMARY.md
- docs/compute/TEST_FIXES_SUMMARY.md
- docs/compute/test-plan.md
- docs/compute/test-runtime-boundary.md
- docs/compute/COMPLETE_TEST_AUDIT.md
- docs/tests/INTEGRATION.md

Notes
- Older, detailed writeups remain available in the archive or original files marked as superseded
- When editing this document, verify all claims against the code: adapter, dom applier, sanitizer, lifecycle, and tests

