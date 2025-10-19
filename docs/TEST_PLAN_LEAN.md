# Lean Test Plan

Use this template to scope the minimum verification required for any change (docs, UI, backend, or compute). Keep it lightweight but explicit—copy the sections below into your PR and fill them out.

## Target behaviour
- Summarize what must be true when the change ships (one or two bullets).
- Call out any invariants that cannot regress (e.g., "Planner emits JSON-only batches", "Replay order preserved").

## Cases to cover
- **Inputs**: canonical success paths (identify representative fixtures or prompts).
- **Edge cases**: boundary conditions, size limits, timeouts, replay/retry scenarios.
- **Error cases**: expected failure modes (validation errors, capability denials, network faults). Include negative tests whenever behaviour changes.

## Assertions
- What outputs, events, metrics, or side-effects prove the behaviour? Reference specific toasts, logs, DB rows, or state paths.
- If failure modes are expected, note the error codes (e.g., `Compute.Timeout`, `E-UICP-0001`) and how they surface.

## Coverage expectations
- List the critical files/functions and the test layer covering each (unit, integration, Playwright, manual).
- Call out any new instrumentation or dashboards that must be checked post-merge.

## Notes
- Mention required fixtures (e.g., `ws:/files/demo.csv`), feature flags, or environment variables.
- Record manual verification steps only when automated coverage is not feasible—and include a plan to automate.

> INVARIANT: Every behaviour change must link to at least one automated test (unit, integration, or E2E). Manual checks are supplementary, never sole coverage.
