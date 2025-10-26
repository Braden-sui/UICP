Error Code Appendix (E-UICP-####)

Scope
- All error codes follow E-UICP-#### (four digits). ASCII only.
- Purpose: one place to find meanings, owners, and typical surfaces.

Conventions
- 01xx Bridge and Tauri invoke/listener wrappers
- 03xx Sanitization and input validation (frontend)
- 04xx Adapter/state/UX routing and bridge listeners
- 05xx LLM/orchestrator/timeout wrappers (frontend) and compute envelope mapping
- 06xx Action log, infra, and host-side utilities
- 07xx Component-specific parse/IO errors (guest components)
- 08xx Component partial/log emission errors (guest components)
- 10xx Linting and policy checks (build-time/static)
- 12xx Reserved (future policy/tooling)
- 52xx E2E harness/test-only shims (non-runtime)
- 62xx Desktop export prompts (front-end adapter)
- 0999 Unknown/default fallback

Catalog

0100 BridgeUnavailable
- File: uicp/src/lib/bridge/result.ts
- Meaning: Tauri bridge not present when invoking a command.
- Surface: frontend toast/log.

0101 InvokeFailed
- File: uicp/src/lib/bridge/result.ts
- Meaning: Tauri invoke rejected/failed.

0102 EventListenerFailed
- File: uicp/src/lib/bridge/result.ts
- Meaning: Failed to register/unregister event listener.

0103–0106 JSON tool collection errors
- Files: docs/archive/2025-10/2025-01-15-json-tool-calling-implementation.md, uicp/tests/unit/collectToolArgs.test.ts
- Meaning: stream parsing/collection failures and timeouts.

0123 Example
- File: AGENTS.MD (example only)
- Meaning: Documentation example; not emitted.

0221 Registry lookup failed
- File: uicp/src-tauri/src/compute.rs
- Meaning: Module resolve error for task@version.

0222 Component load failed
- File: uicp/src-tauri/src/compute.rs
- Meaning: Could not load compiled component from cache/path.

0223 Instantiate component failed
- File: uicp/src-tauri/src/compute.rs
- Meaning: Instantiation/linkage error (missing or mismatched import).

0224–0227 WIT binding/call failures
- File: uicp/src-tauri/src/compute.rs
- Meaning: Guest binding init or export call errors (csv.parse/table.query).

0228 Component import inspection failed
- File: uicp/src-tauri/src/compute.rs

0229 Component preflight failed
- File: uicp/src-tauri/src/registry.rs

0230 Import policy violation or contract load failure
- Files: uicp/src-tauri/src/compute.rs, docs/compute/COMPUTE_RUNTIME_CHECKLIST.md

0231 Linker instantiate_pre failed (contract)
- File: uicp/src-tauri/src/compute.rs

0233 Instantiate (contract verification) failed
- File: uicp/src-tauri/src/compute.rs

0234–0235 Contract binding init failed (csv/table)
- File: uicp/src-tauri/src/compute.rs

0240 Module contract verification failed
- File: uicp/src-tauri/src/registry.rs

0300 Sanitization/validation cap exceeded
- File: uicp/src/lib/uicp/adapters/adapter.events.ts
- Meaning: data-command exceeds caps (size or template-token count).

0301 DataCommandInvalid
- Files: uicp/src/lib/uicp/adapters/adapter.events.ts, tests, docs
- Meaning: data-command evaluated to invalid or empty batch.

0302 SanitizeOutputInvalid
- File: uicp/src/lib/utils.ts
- Meaning: DOMPurify returned unexpected type.

0400 WorkspaceNotReady
- File: uicp/src/lib/bridge/result.ts

0401 Window/Listener ops
- Files: uicp/src/lib/bridge/result.ts, uicp/src/lib/llm/ollama.ts
- Meaning: Failed to unregister listener or window-level not found conditions.

0401–0407 Compute input detail codes
- File: uicp/src-tauri/src/compute_input.rs
- Meaning: CSV/table/workspace path/fs caps/IO/script/codegen detail classification for messages

0410–0415 Harness admin routine errors
- File: uicp/src-tauri/src/test_support/harness.rs

0420–0421 Stream/normalization warnings (text comments)
- Files: uicp/src/lib/uicp/stream.ts (0421 log), refs in tests/docs.

0500 ComputeTimeout
- File: uicp/src/lib/bridge/result.ts

0501 Timeout and iterator cleanup
- Files: uicp/src/lib/orchestrator/collectTextFromChannels.ts
- Meaning: LLM timeout and cleanup failures.

0502–0507 Compute error classes
- File: uicp/src/lib/bridge/result.ts
- Meaning: Cancelled, capability denied, resource limit, runtime fault, IO denied, task not found, nondeterministic.

0601 Action log append failure
- File: uicp/src-tauri/src/compute.rs
- Meaning: Host action-log append failed (panic in current code path).

0602–0604 Reserved (infra)

0620–0632 Action log validation/verification errors
- File: uicp/src-tauri/src/action_log.rs
- Meaning: Hash, nonce, prev_hash, signature verification, directory creation, pubkey parsing.

0640–0646 CLI errors for uicp-log
- File: uicp/src-tauri/src/bin/uicp_log.rs

0660 Boot action-log append failure (non-fatal)
- File: uicp/src-tauri/src/main.rs

0701 Job token validation failed
- File: uicp/src-tauri/src/main.rs
- Meaning: Missing or invalid job token for compute job

0703–0710 Applet.quickjs prewarm/instantiate errors
- File: uicp/src-tauri/src/compute.rs
- Meaning: Component instantiation, binding init, or prewarm call failures

0801 table.query partial emission failed
- File: uicp/components/table.query/src/lib.rs

14xx Code provider errors (Codex, Claude CLI)

1400 Provider config error
- File: uicp/src-tauri/src/code_provider.rs
- Meaning: Unable to resolve home directory or other config issue

1401 Provider spawn error
- File: uicp/src-tauri/src/code_provider.rs
- Meaning: Failed to spawn provider CLI process

1402 Provider IO error
- File: uicp/src-tauri/src/code_provider.rs
- Meaning: Provider stdin write, wait, or filesystem operation failed

1403 Provider exit error
- File: uicp/src-tauri/src/code_provider.rs
- Meaning: Provider CLI exited with non-zero status code

1404 Provider parse error
- File: uicp/src-tauri/src/code_provider.rs
- Meaning: Failed to parse provider output JSON or session logs

1405 Provider session error
- File: uicp/src-tauri/src/code_provider.rs
- Meaning: Failed to read or scan provider session logs

1406 Httpjail disabled warning
- File: uicp/src-tauri/src/code_provider.rs
- Meaning: httpjail requested but not enforced (non-fatal warning)

0999 Unknown
- File: uicp/src/lib/bridge/result.ts
- Meaning: Fallback mapping when no specific code applies.

1001–1002 ESLint policy violations
- File: uicp/eslint.config.js
- Meaning: innerHTML bans for dynamic/template content.

1201 Reserved (policy/tools)

5201–5202 Test harness only
- File: uicp/tests/e2e/compute.smoke.spec.ts
- Meaning: E2E harness failure codes; not used in runtime.

6201–6202 Desktop export prompts
- File: uicp/src/lib/uicp/adapters/adapter.fs.ts
- Meaning: User confirmation unavailable or denied.

How to add a new code
- Pick the appropriate range from Conventions and choose an unused ####.
- Add it to the emitting code and update this appendix.
- For compute plane errors, prefer mapping to terminal classes (Compute.Timeout, etc.) and attach details with an E-UICP-#### only where a concrete cause is known.

