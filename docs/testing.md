# Testing Guide

Last updated: 2025-10-26

Purpose: how to run and interpret the test suites, by layer.

Node/Frontend
- Unit: `pnpm -C uicp run test` (Vitest). Fast feedback over state management, adapter semantics, orchestrator parsing, UI components.
- E2E: `pnpm -C uicp run test:e2e` (Playwright). Smoke of critical flows; builds and runs preview.

Rust/Backend
- Library checks: `cargo check -p uicp --lib` (fast surface validation).
- Full (feature-gated): compute tests require `--features wasm_compute` and valid Wasmtime version.

Layers and expectations
- Unit (pure logic). No network, deterministic.
- Contract (public APIs and schemas). Snapshot/golden where applicable.
- Integration (service boundaries). Real lightweight dependencies; thin fakes for heavy ones.
- E2E (critical journeys). Keep few and stable.

Negative and boundary cases
- Invalid inputs, timeouts, partial failures. Tests assert loud failures with error codes (e.g., E-UICP-0100 timeouts).

Observability in tests
- Structured events and spans are asserted via test helpers where applicable.

