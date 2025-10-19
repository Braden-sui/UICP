## 0.2.0 - Generative desktop shell
- Replace the legacy inspector UI with a clean empty desktop canvas and DockChat surface.
- Add DockChat planner pipeline with full control gating and STOP lockout.
- Ship UICP batch adapter, schemas, and Tauri event transport for agent-driven control.
- Stamp trace/txn metadata on orchestrator batches, add desktop logs panel, and harden planner/actor fallbacks.
- Add Vitest + Playwright coverage and CI workflow enforcing lint, typecheck, unit, e2e, and build.

## Unreleased
- Add WASI applet world `uicp:applet-script@0.1.0` with host bindgen and compute dispatch.
- New compute input parser for script modes: `render`, `on-event`, `init`.
- Registry supports loading `script.*@version` modules; import preflight registered.
- Added optional integration test (skips if module absent) proving `<div>hello</div>` render via harness.
