Placeholder Cleanup Checklist

Purpose: Track and remove or replace every placeholder in code, tests, and docs. Treat each as a TODO with clear exit criteria. Prefer fail‑loud behavior until replaced.

Runtime/Host (Rust)
- [ ] uicp/src-tauri/src/compute.rs:5 — Placeholder events when Wasm runtime disabled. Exit: always ship wasm_compute in releases or provide a non-placeholder deterministic path with explicit error taxonomy.
- [ ] uicp/src-tauri/src/compute.rs:145 — Determinism “placeholders” (seeded RNG/logical clock). Exit: replace with finalized determinism strategy and tests (goldens; outputHash parity across runs).
- [ ] uicp/src-tauri/src/compute.rs:204 — Preopen helper placeholder note. Exit: enforce explicit read-only preopen with DirPerms/FilePerms and integration tests for read/deny write/escape.
- [ ] uicp/src-tauri/src/compute.rs:929 — No-runtime placeholder job. Exit: gate behind build profile and never used in shipped builds; add test-only path or remove entirely.
- [ ] uicp/src-tauri/src/main.rs:1729 — Recovery action placeholder. Exit: implement restore/rollback/reset flows with Safe Mode, logs, and tests.

Docs
- [ ] docs/architecture.md:103 — “enqueue_command: placeholder for the tool queue.” Exit: finalize tool queue API and update docs with real flow and constraints.
- [ ] docs/compute/host-skeleton.rs:72 — Placeholder types in host sketch. Exit: replace with codegen’d bindings or delete the sketch once runtime is stable.
- [ ] docs/setup.md:100 — “non‑Wasm placeholder path” toggle. Exit: clarify supported modes; remove placeholder path instructions from primary setup.
- [ ] docs/harmony-samples.md:169 — “analysis content is placeholder.” Exit: ensure examples demonstrate minimal analysis and are labeled as examples, not production content.
- [x] .agent-policy.yml — Tier mapping file committed; spec operationalized.

Integration Tests (scaffolds)
- [ ] uicp/src-tauri/tests/integration_persistence/shakedown.rs:4 — “integration harness pending.” Exit: implement harness and unignore.
- [ ] uicp/src-tauri/tests/integration_persistence/persist_apply_roundtrip.rs:2 — scaffold note. Exit: replace with Tauri command-driven test; remove harness dependency or wire it in CI.
- [ ] uicp/src-tauri/tests/integration_persistence/schema_migration_guard.rs:4 — pending. Exit: simulate schema mismatch; assert Safe Mode and user choices.
- [ ] uicp/src-tauri/tests/integration_persistence/concurrency_visibility.rs:4 — pending. Exit: load test for apply/persist ordering; assert last-write-wins and replay correctness.
- [ ] uicp/src-tauri/tests/integration_persistence/replay_with_missing_results.rs:4 — pending. Exit: enforce replay behavior for missing finals and replayable jobs.

UI and Mocks (intentional placeholders — decide per case)
- [ ] uicp/src/components/DockChat.tsx:264 — Placeholder text prompt. Exit: confirm final UX copy or move to i18n strings.
- [ ] uicp/src/components/NotepadWindow.tsx:100,121 — Placeholder strings. Exit: confirm copy or move to i18n.
- [ ] uicp/src/components/ComputeDemoWindow.tsx:170 — Workspace path placeholder. Exit: keep or provide file picker.
- [ ] uicp/src/lib/mock.ts:33,50 — Mock HTML placeholders. Exit: keep as test-only or replace with real components in demo paths.
- [ ] uicp/src/lib/uicp/adapter.ts:907,918 — Placeholder form/component HTML. Exit: migrate to real component library or remove legacy mock paths.
- [ ] uicp/tests/e2e/specs/generative-desktop.spec.ts:11 — Uses placeholder selector text. Exit: stabilize selectors independent of human copy.
- [ ] uicp/tests/e2e/specs/orchestrator-flow.spec.ts:20 — Uses placeholder selector text. Exit: same as above.
- [ ] uicp/tests/unit/DockChat.test.tsx: select by placeholder text. Exit: prefer stable test IDs.

Prompts (ensure no “placeholder” guidance persists)
- [ ] uicp/src/prompts/planner.txt:194,200 — Field placeholder guidance. Exit: keep guidance but ensure outputs never include placeholder filler content.
- [ ] uicp/src/prompts/actor.txt:18 — “Never leave placeholder HTML.” Exit: verify with tests that actor outputs never contain placeholder tokens.

Acceptance Criteria per item
- Replace placeholder with production behavior or remove the code path.
- Add tests that would fail if placeholder behavior sneaks back in.
- Update docs to remove placeholder wording.
- For UI copy, confirm phrasing with product or move to i18n.

Owner/Status (fill during triage)
- Owner: ________  Target date: __________  Status: [todo|in-progress|done]
