# Compute CI Smoke Gate (2025-10-13)

- Touched modules & why: `.github/workflows/compute-ci.yml` gains rust target install, prebuild of the `compute_harness` binary, an explicit Vite build, and targeted Playwright smoke to block regressions; `docs/STATUS.md` updated to reflect the new guard.
- Invariants to preserve: compute harness must compile with `wasm_compute`, `uicp_wasi_enable`, and `compute_harness` features; Playwright smoke must launch against a built bundle and fail loud on host/guest drift.
- Risks & blast radius: CI-only change; failure blocks PR merges but does not ship to end users. Primary risk is flakiness in Playwright smoke due to compute harness timing.
- Autonomy Tier & rationale: Tier 1 (CI gate for public behavior; impact moderate, revert trivial, confidence high via existing tests).
- Observability: rely on Playwright smoke assertions plus existing host logging; follow-up to attach metrics if flakes appear.
- Rollback plan: revert the workflow and doc changes to restore prior CI behavior; optional to skip the Playwright smoke by removing the new step.
