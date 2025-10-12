UICP Multi-Agent Architecture (v1)

Summary
- Planner: outputs a plain-text outline (Summary, Steps, Risks, ActorHints, AppNotes). No JSON. No WIL.
- Actor (GUI): emits WIL only, one command per line. No commentary. Stop on first `nop:`.
- Orchestrator (Tauri/Rust): parses Planner text -> Plan (empty batch); parses Actor WIL -> typed ops; applies UI; enforces caps and telemetry.
- App Agent (sidecar, v1.1): JSON-RPC over stdio to build/run components (deferred in v1.0).

Contracts
- Planner: plain text sections; single batched clarifier turn (<=3 default, <=5 hard). Do not instruct Actor to ask.
- Actor: WIL only, one line per op, enforce caps (50 default / 200 hard). Emit `nop:` and stop if blocked.
- Orchestrator: WIL-only ingestion for Planner/Actor (no model JSON). On `nop:` route control back to Planner with reason; on other actor failures, surface error window.

WIL
- Lexicon: `uicp/src/lib/wil/lexicon.ts` (exhaustive over OperationNameT).
- Parser: `uicp/src/lib/wil/parse.ts` (templates, skip-words, slot post-process including size WxH).
- Map/Validate: `uicp/src/lib/wil/map.ts` + `validateBatch`.

Parsing & Streaming
- Text collector: `uicp/src/lib/orchestrator/collectTextFromChannels.ts` (content channels + return events).
- Batch parser: `uicp/src/lib/orchestrator/parseWILBatch.ts` (defence code blocks, caps, `nop:` early exit).
- Streaming aggregator: `uicp/src/lib/uicp/stream.ts` (WIL-only path).

Prompts
- Planner: `uicp/src/prompts/planner.txt`
- Actor: `uicp/src/prompts/actor.txt`
- WIL guide: `uicp/src/prompts/wil.txt`

Caps & Config
- `uicp/src/lib/config.ts`: FOLLOWUP_MAX_*, ACTOR_BATCH_*, APP_* budgets; `VITE_WIL_ONLY=1` default.

Tests
- Orchestrator integration & fallbacks: `uicp/tests/unit/orchestrator*.test.ts`
- Aggregator (WIL): `uicp/tests/unit/uicp.aggregator.test.ts`
- WIL property-like tests: `uicp/tests/unit/wil/batch.property.test.ts`

Security & Safety
- No model JSON in Planner/Actor paths (OWASP LLM02 mitigation). All structure built locally.
- Typed validation via Zod schemas; HTML sanitized gates; budgets enforced.

