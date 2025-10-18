## 0.2.0 - Generative desktop shell
- Replace the legacy inspector UI with a clean empty desktop canvas and DockChat surface.
- Add DockChat planner pipeline with full control gating and STOP lockout.
- Ship UICP batch adapter, schemas, and Tauri event transport for agent-driven control.
- Stamp trace/txn metadata on orchestrator batches, add desktop logs panel, and harden planner/actor fallbacks.
- Add Vitest + Playwright coverage and CI workflow enforcing lint, typecheck, unit, e2e, and build.
