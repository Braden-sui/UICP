WIL Refactor — Tracking Log (v1)

Intent
- Remove JSON emission from models. Planner emits plain text plans; Actor emits WIL lines. The app builds typed ops deterministically from words.

Scope (landed)
- Prompts: Planner (plain text sections) and Actor (WIL only) defined.
- Orchestrator: WIL-only ingestion for Planner and Actor; text collectors; batch parser; caps; early `nop:`.
- Aggregator: switched to WIL parsing (no tool-call merging).
- Safety: Zod validation, HTML guardrails, caps; no model JSON in Planner/Actor flows.

Key Files
- Planner prompt: `uicp/src/prompts/planner.txt`
- Actor prompt: `uicp/src/prompts/actor.txt`
- WIL lexicon: `uicp/src/lib/wil/lexicon.ts`
- WIL parser: `uicp/src/lib/wil/parse.ts`
- Batch parser: `uicp/src/lib/orchestrator/parseWILBatch.ts`
- Text collector: `uicp/src/lib/orchestrator/collectTextFromChannels.ts`
- Orchestrator: `uicp/src/lib/llm/orchestrator.ts`
- Aggregator: `uicp/src/lib/uicp/stream.ts`
- Config/caps: `uicp/src/lib/config.ts`
- Architecture: `docs/architecture.md`

Decisions
- Planner/Actor WIL is authoritative; JSON is disabled in these paths.
- `nop:` stops the actor batch and routes back to Planner (notice = `planner_fallback`).
- Default caps: actor batch 50 (hard 200); clarifier single turn (<=3 default, 5 hard).

Open Risks
- Lexicon coverage growth needs a steady cadence and tests.
- Internationalization (WIL templates per language) is deferred.
- Clarifier UX (Planner prompts) could benefit from a helper to format multiple-choice follow-ups.

Next Suggestions (execution plan)
1) Expand lexicon/templates for core ops [in progress]
   - Add move/resize patterns for window.update.
   - Add more DOM/Component synonyms.
   - Tests for new templates.

2) Clarifier path helper [planned]
   - Utility to compose batched clarifier questions (multiple choice + suggested default).
   - Hook to include actor `nop` reason + context for Planner.

3) Observability [planned]
   - Opt-in WIL debug logs with line counts, first-error reason.
   - Counters on nop / parse failure.

4) UI feedback [planned]
   - Surface `planner_fallback` (nop) reason in chat/system status.

DoD v1
- WIL-only Planner/Actor run paths with tests.
- Lexicon covers top operations.
- `nop` routed to Planner with reason.
- Docs: ARCHITECTURE + this tracker.

Backlog / TODOs (comprehensive)

Prompts & Profiles
- [ ] Audit all profiles to ensure Planner is plain-text, Actor emits WIL only (no tools).
- [ ] Add a short “WIL Quickstart” link in both prompts (already in docs/compute/WIL_QUICKSTART.md).
- [ ] Gate any legacy tool schemas behind an explicit env for temporary compatibility, then remove.

Orchestrator
- [ ] Enforce `plannerCap` at runtime (turn counters + questions per batch) and surface violations to Planner.
- [ ] Add small helper to format clarifier multiple-choice blocks (with suggested defaults) and stitch into planner prompt injection.
- [ ] Optional: when `planner_fallback` due to nop, carry forward a suggested summary and actor hints to accelerate re-planning.
- [ ] Add metrics hooks (counts, reasons) around WIL parse results and nop causes.

WIL Lexicon & Parser
- [ ] Add more templates/synonyms:
  - DOM: “insert/replace/append” variants; allow quoted/unquoted selectors.
  - Components: short “mount {type} in {target} with {props}” (props as JSON) pattern.
  - State: friendly verbs for watch/unwatch; optional scope words (“in window/workspace/global”).
- [ ] I18n plan (per-language template sets, same op keys) — postpone until v1.1.
- [ ] Optional: YAML-driven templates (Hassil-style) generator; keep TS as the single source of truth.
- [ ] Property-like tests for slot coercions (numbers, enums, JSON props).

Aggregator
- [ ] Add a minimal “preview WIL” developer toggle to dump first N WIL lines for inspection.
- [ ] Add non-breaking backpressure guard: drop excess commentary older than M KB to avoid OOM on long streams.

Clarifier Flow
- [ ] Implement Planner clarifier composer: inputs (missing slots + context) → 1 message with <=3 multiple-choice questions.
- [ ] Wire Orchestrator to call the clarifier composer when `nop` occurs and re-enter Planner once.
- [ ] Tests: single clarifier turn respected; exceeding caps yields a structured system message to the user.

Observability & Telemetry
- [ ] WIL debug logs are present; add counters for: total lines, ops parsed, first error line, nop reasons.
- [ ] Add OpenTelemetry spans in Rust host (planning, acting, apply phases) with durations and outcomes.
- [ ] Add lightweight JS metrics (dev only) or route to existing telemetry sink if available.

App Agent (v1.1)
- [ ] Keep JSON-RPC sidecar behind a feature flag; add a small test harness and a hello-world component.
- [ ] Add budgets in Rust host (epochs/memory) and a basic policy for allowed capabilities.
- [ ] Define the AppSpec validator (TS + Rust if applicable) and tests.

Security & Policy
- [ ] Secret scanning and SBOM jobs confirm; no model output executed; WIL-only design documented (OWASP LLM02 mitigations).
- [ ] Ensure Tauri capability and plugin permission scopes are minimal for the sidecar.
- [ ] Verify sanitize gates remain enforced (dom.* HTML) and keep snapshots.

Docs
- [ ] Update README to link to architecture.md and WIL_QUICKSTART.md.
- [ ] Add a short “How to add a new WIL op” guide (edit lexicon, add tests, examples).
- [ ] Record clarifier UX and caps in Planner prompt docs.

CI & Config
- [ ] Keep `VITE_WIL_ONLY=1` default in CI; add a nightly to run with `VITE_WIL_DEBUG=1` to collect line stats.
- [ ] Remove any last JSON-tool tests once WIL coverage is complete.

Tests
- [ ] Add integration tests for multi-line WIL with mixed valid + nop lines (stops and routes).
- [ ] Add end-to-end smoke that models “Planner outline → Actor WIL → UI applied” without regressions.
- [ ] Expand property-like tests for WxH, x,y, and enums.

Cleanup
- [ ] Audit for stale imports referencing `../llm/json` or tool schemas (done for major paths; re-run search before closing).
- [ ] Remove comments and docs referencing tool calling in Planner/Actor.

Observability (Rust/JS)
- [x] JS: Add WIL_STATS counters and optional debug logs.
- [ ] Rust: Feature-gated tracing (`otel_spans`) with spans for planning/acting/apply.
