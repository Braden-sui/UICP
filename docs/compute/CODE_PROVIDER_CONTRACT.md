# Code Provider Contract (needs.code)

Purpose
- Define the minimal, precise contract that the `needs.code` spec must satisfy so code providers (Codex, Claude) can operate autonomously and safely in this repo.
- Aligns with AGENTS.MD: deterministic edits, typed errors, tests on green, and no TODOs.

Invocation (for awareness)
- Frontend: Actor emits `needs.code`; UI executor submits `codegen.run@0.1.0` with your `spec` as the provider prompt.
- Provider: 
  - Codex: `codex exec --json --output-schema schema.json --full-auto "<spec>"` (httpjail network allowlist enforced when enabled).
  - Claude: `claude --output-format stream-json --permission-mode acceptEdits` (httpjail when enabled).
- Output is normalized into `{ code, language, meta, diffs? }` and surfaced back to the UI. Diffs are harvested from session logs when available.

Required sections in `spec` (strict)
1) Context Summary
   - One sentence goal; include risk tier if known (T0–T3) and invariants to preserve.
2) Edit Surface (authoritative)
   - Exact file paths to change and why. List functions, exports, or symbols to modify/create.
   - State any forbidden files or modules to avoid unrelated churn.
3) Constraints (must-haves)
   - Languages and style: TypeScript strict, no implicit any; Rust typed errors (anyhow or enums); Python typing if used.
   - Error codes: use `E-UICP-####` format with clear messages; no TODO/FIXME.
   - Security: no secrets, sanitize logs, respect httpjail.
4) Tests and Validation
   - Which tests to add/update; what they prove (positive/negative).
   - Commands to validate: e.g. `pnpm -w -C uicp test`, `cargo test -p uicp` (adjust to the touched area).
   - Acceptance: zero warnings, all tests green.
5) Patch Policy
   - Smallest correct change, minimal diff, no unrelated refactors.
   - Keep filenames and public APIs stable unless explicitly required by the goal.
6) Observability (if applicable)
   - Logs/metrics/traces to add; include brief rationale.
7) Output Format (provider response)
   - Primary JSON: `{ "code": "<string>", "language": "ts|rust|python", "meta": { ... } }`.
   - If the provider also emits file diffs via its session stream, include them; the host will harvest and attach under `meta.diffs`.
   - Do not emit placeholders; provide complete code for the declared edit surface.

Permissions & Limits
- Network: default‑deny via httpjail; only allowlisted hosts may be reachable.
- Filesystem: write changes inside the workspace only; no vendored/build artifacts.
- Execution: may run local tools (tests, formatters) when available; do not introduce new global deps in the spec.

Failure Handling
- If required inputs to satisfy the goal are missing or ambiguous, state the single blocking item at the top of the output `meta.blocker` and stop; do not invent context.
- Include a succinct `meta.validation` summary when tests fail, with the command and first failing assertion.

Notes
- This contract is about the spec content the Actor/Planner provide; it is not a recipe. The provider’s reasoning and code are fully autonomous within these guardrails.

