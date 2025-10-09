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
- [x] uicp/src-tauri/tests/integration_persistence/schema_migration_guard.rs:4 — Resolved: added FK-violation detection via `harness fk-check`; simulates schema/constraint mismatch and asserts detection (proxy for Safe Mode entry in app).
- [x] uicp/src-tauri/tests/integration_persistence/concurrency_visibility.rs:4 — Resolved: added `harness materialize` (last-write-wins) and flood writes; asserts materialized value matches the final write.
- [x] uicp/src-tauri/tests/integration_persistence/replay_with_missing_results.rs:4 — Resolved: added `harness count-missing`; verifies `compact-log` deletes trailing incomplete rows beyond checkpoint.

- UI and Mocks (intentional placeholders — decide per case)
- [x] uicp/src/components/DockChat.tsx:264 — Placeholder text prompt. Resolved: moved to `uicp/src/strings.ts`; added `data-testid="dockchat-input"` and kept `data-dock-chat-input`.
- [x] uicp/src/components/NotepadWindow.tsx:100,121 — Placeholder strings. Resolved: moved to `uicp/src/strings.ts`.
- [x] uicp/src/components/ComputeDemoWindow.tsx:170 — Workspace path placeholder. Resolved: added Import File… (Tauri dialog) + `copy_into_files` command; updates `ws:/files/...` automatically.
- [x] uicp/src/lib/mock.ts:33,50 — Mock HTML placeholders. Decision: keep as test-only illustrative markup; no visible "placeholder" wording in copy.
- [x] uicp/src/lib/uicp/adapter.ts:907,918 — Placeholder form/component HTML. Resolved: default now says "Prototype component"; no placeholder wording. Added unit test.
- [x] uicp/tests/e2e/specs/generative-desktop.spec.ts:11 — Resolved: selectors stabilized via `[data-testid="dockchat-input"]`.
- [x] uicp/tests/e2e/specs/orchestrator-flow.spec.ts:20 — Resolved: selectors stabilized via `[data-testid="dockchat-input"]`.
- [x] uicp/tests/unit/DockChat.test.tsx — Resolved: now selects via `getByTestId('dockchat-input')`.
- [x] uicp/src/components/AgentSettingsWindow.tsx:56-58,66-69,75-77 — Resolved: surface errors via toast for get_modules_info, copy path, and open folder failures; unit test added.

Prompts (ensure no “placeholder” guidance persists)
- [x] uicp/src/prompts/planner.txt:194,200 — Resolved: explicit rule added — do not use the literal word "placeholder" in any visible text (input placeholder attributes allowed).
- [x] uicp/src/prompts/actor.txt:18 — Resolved: sanity test asserts the prohibition is present; adapter tests ensure no placeholder wording in mock output.

Acceptance Criteria per item
- Replace placeholder with production behavior or remove the code path.
- Add tests that would fail if placeholder behavior sneaks back in.
- Update docs to remove placeholder wording.
- For UI copy, confirm phrasing with product or move to i18n.

Owner/Status (fill during triage)
- Owner: Codex  Target date: 2025-10-10  Status: done
