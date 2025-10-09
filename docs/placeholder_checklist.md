Placeholder Cleanup Checklist

Purpose: Track and remove or replace every placeholder in code, tests, and docs. Treat each as a TODO with clear exit criteria. Prefer fail-loud behavior until replaced.

Runtime/Host (Rust)
- [x] uicp/src-tauri/src/compute.rs:5 — Placeholder events when Wasm runtime disabled. Resolved: now surfaces a structured `Runtime.Fault` error.
- [x] uicp/src-tauri/src/compute.rs:145 — Determinism “placeholders” (seeded RNG/logical clock). Resolved: comment clarified; behavior is intentional for repeatable telemetry.
- [x] uicp/src-tauri/src/compute.rs:204 — Preopen helper placeholder note. Resolved: replaced with explicit read-only preopen using `preopened_dir_with_capabilities`.
- [x] uicp/src-tauri/src/compute.rs:929 — No-runtime placeholder job. Resolved: now fails immediately with a clear error when runtime is disabled.
- [x] uicp/src-tauri/src/main.rs:1729 — Recovery action placeholder. Resolved: implemented with `reindex`, `compact_log`, `rollback_checkpoint`, and other actions.

Docs
- [x] docs/architecture.md:103 — “enqueue_command: placeholder for the tool queue.” Resolved: docs now describe the queue persistence behavior.
- [x] docs/compute/host-skeleton.rs:72 — Placeholder types in host sketch. Resolved: marked as illustrative example of current types.
- [x] docs/setup.md:100 — “non‑Wasm placeholder path” toggle. Resolved: clarified legacy/debug usage and removed placeholder wording.
- [x] docs/harmony-samples.md:169 — “analysis content is placeholder.” Resolved: language now says “illustrative”, keeping guidance on minimal analysis.
- [x] .agent-policy.yml — Tier mapping file committed; spec operationalized.

Integration Tests (scaffolds)
- [x] uicp/src-tauri/tests/integration_persistence/shakedown.rs:4 — Resolved: unignored; will run in CI rust-tests job.
- [x] uicp/src-tauri/tests/integration_persistence/persist_apply_roundtrip.rs:2 — Resolved: added CLI harness at `uicp/src-tauri/src/bin/harness.rs` and wired via `[[bin]]` in Cargo.toml. Next: optionally add a Tauri command-driven variant.
- [ ] uicp/src-tauri/tests/integration_persistence/schema_migration_guard.rs:4 — pending. Exit: simulate schema mismatch; assert Safe Mode and user choices.
- [ ] uicp/src-tauri/tests/integration_persistence/concurrency_visibility.rs:4 — pending. Exit: load test for apply/persist ordering; assert last-write-wins and replay correctness.
- [ ] uicp/src-tauri/tests/integration_persistence/replay_with_missing_results.rs:4 — pending. Exit: enforce replay behavior for missing finals and replayable jobs.

- UI and Mocks (intentional placeholders — decide per case)
- [x] uicp/src/components/DockChat.tsx:264 — Placeholder text prompt. Resolved: moved to `uicp/src/strings.ts`; added `data-testid="dockchat-input"` and kept `data-dock-chat-input`.
- [x] uicp/src/components/NotepadWindow.tsx:100,121 — Placeholder strings. Resolved: moved to `uicp/src/strings.ts`.
- [ ] uicp/src/components/ComputeDemoWindow.tsx:170 — Workspace path placeholder. Exit: keep or provide file picker.
- [ ] uicp/src/lib/mock.ts:33,50 — Mock HTML placeholders. Exit: keep as test-only or replace with real components in demo paths.
- [ ] uicp/src/lib/uicp/adapter.ts:907,918 — Placeholder form/component HTML. Exit: migrate to real component library or remove legacy mock paths.
- [x] uicp/tests/e2e/specs/generative-desktop.spec.ts:11 — Resolved: selectors stabilized via `[data-testid="dockchat-input"]`.
- [x] uicp/tests/e2e/specs/orchestrator-flow.spec.ts:20 — Resolved: selectors stabilized via `[data-testid="dockchat-input"]`.
- [x] uicp/tests/unit/DockChat.test.tsx — Resolved: now selects via `getByTestId('dockchat-input')`.
- [ ] uicp/src/components/AgentSettingsWindow.tsx:56-58,66-69,75-77 — Silent catch acts as placeholder error handling. Exit: surface errors (toast or inline) for get_modules_info, copy path, and open folder failures; add unit tests that fail on swallowed errors.

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
