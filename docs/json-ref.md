# JSON Tool Calling Reference (UICP)

Purpose: Migrate planner/actor from WIL text to JSON tool calling with safe fallbacks, observability, and tests. This is the authoritative checklist and spec for the transition.

Status: Hybrid recommended now (JSON-first, WIL-fallback). Tools-only is a later cutover after proofs.

---

## Overview

- Tools and schemas live in `uicp/src/lib/llm/tools.ts`.
- Transport uses the existing Tauri streaming channel `ollama-completion` from `uicp/src-tauri/src/main.rs`.
- Frontend stream listener is `uicp/src/lib/llm/ollama.ts`.
- Planner/Actor orchestrator is `uicp/src/lib/llm/orchestrator.ts`.
- Provider wiring (messages, tools, response_format) is `uicp/src/lib/llm/provider.ts`.
- Streaming apply aggregator is `uicp/src/lib/uicp/stream.ts` (WIL today; JSON extension described below).

---

## Schemas and Tool Specs

- Tool names
  - `emit_plan` → returns a Plan
  - `emit_batch` → returns a Batch
- JSON Schemas (OpenAI `json_schema` compatible)
  - `planSchema` and `batchSchema` in `uicp/src/lib/llm/tools.ts`
  - Envelope field set: `op` (enum of `OperationName`), `params`, plus optional `id`, `idempotencyKey`, `traceId`, `txnId`, `windowId`
- Contract
  - Planner emits object `{ summary, risks?, actor_hints?, batch: Envelope[] }`
  - Actor emits object `{ batch: Envelope[] }`
- Invariants
  - `op` must be a valid operation.
  - `batch` validates with `validateBatch()` (`uicp/src/lib/uicp/schemas.ts`).
  - Fail loud on schema mismatch (no silent drop).

---

## Environment Flags

- `VITE_WIL_ONLY` (boolean)
  - true → WIL-only (current default in `uicp/src/lib/config.ts`)
  - false → JSON-first, WIL-fallback
- `FALLBACK_CLOUD_MODEL`
  - e.g., `kimi-k2:1t`; used by backend on 4xx/5xx to retry once with an alternate model.
- Proposed (optional future)
  - `VITE_TOOLS_ONLY` (boolean): if true, disallow WIL fallback (enable only after JSON path is fully proven).

---

## Profiles (per-model capability)

- File: `uicp/src/lib/llm/profiles.ts`
- Set `capabilities.supportsTools: true` on planner/actor profiles that can use tool calling.
- Add dedicated profiles (e.g., `kimi-tools`, `qwen-tools`) to roll out per model without breaking existing profiles.

---

## Provider Wiring (messages → transport)

- File: `uicp/src/lib/llm/provider.ts`
- When `supportsTools` is true, provider already sets:
  - `tools: [EMIT_PLAN]` (planner) / `[EMIT_BATCH]` (actor)
  - `toolChoice` to the matching function name
  - `response_format` to `{ type: 'json_schema', json_schema: { name, schema } }`
  - `format: 'json'` as a hint
- Include `buildEnvironmentSnapshot()` in the `system` seed for context (reused from WIL path).

---

## Orchestrator (JSON-first, WIL-fallback)

- File: `uicp/src/lib/llm/orchestrator.ts`
- Planner (`planWithProfile`):
  1) If `supportsTools && !cfg.wilOnly`: collect `tool_call` arguments for `emit_plan` into JSON; `validatePlan()`.
  2) Else, attempt `tryParseBatchFromJson(text)` if the model sent final JSON as content.
  3) Else, `collectTextFromChannels()` and parse outline sections via `parsePlannerOutline()` (legacy text path).
  4) Retry once with `buildStructuredRetryMessage('emit_plan', err)` on schema failure.
- Actor (`actWithProfile`):
  1) If `supportsTools && !cfg.wilOnly`: collect `emit_batch` JSON and `validateBatch()`.
  2) Else, try `tryParseBatchFromJson(text)`.
  3) Else, parse WIL text via `parseWILBatch(text)` and validate.
  4) `actor_nop:` still routes clarifier flow as today.
- Keep `augmentPlan()` logic and clarifier flow unchanged.

---

## Streaming Aggregator (Apply path)

- Current: `uicp/src/lib/uicp/stream.ts` aggregates text → WIL via `parseWILBatch()`.
- JSON extension (to implement):
  - Accumulate `json` channel text; on `flush()`, parse `{ batch: [...] }` and `validateBatch()`.
  - Alternatively, accumulate `tool_call` deltas for `emit_batch` and apply final args.
  - Gate by: `supportsTools && !cfg.wilOnly`.
- Bridge integration: `uicp/src/lib/bridge/tauri.ts` chooses aggregator; keep WIL aggregator for fallback and tests.

---

## Backend Transport & Errors

- File: `uicp/src-tauri/src/main.rs`
  - Emits `ollama-completion` SSE-like events.
  - On upstream errors: sends `{ done: true, error: { status, code, detail, requestId, retryAfterMs? } }`.
- File: `uicp/src/lib/llm/ollama.ts`
  - On `payload.done && payload.error`, now fails the queue (no silent completion) and ends the stream.
  - Emits `llm_error` and `llm_complete` with context.

---

## Observability (what to log/track)

- UI Debug events (frontend): `ui-debug-log`
  - Request lifecycle: `llm_request_started`, `llm_delta`, `llm_complete`, `llm_error`.
  - Planner/Actor source: `planner_source=tool|json|text`, `actor_source=tool|json|text` (add when implementing JSON-first).
- Backend debug: `request_started`, `response_status`, `response_failure`, `stream_eof`, `completed`, `retry_backoff`, `no_fallback_configured`.
- Metrics to watch:
  - Tool success rate, JSON parse errors, WIL fallback rate
  - Latency p50/p95/p99 per source

---

## Tests (minimums for the migration)

- Unit
  - Tool plan: collect `emit_plan` deltas → `validatePlan()`
  - Tool batch: collect `emit_batch` deltas → `validateBatch()`
  - JSON aggregator: parse `json` channel lines into batch and apply
  - Negative: malformed tool args → retry once → fallback to WIL; verify loud failure
- Contract
  - Validate tool payloads against `planSchema`/`batchSchema` (goldens)
- Integration (smoke)
  - End-to-end tools-enabled profile: produces a valid batch with no WIL
- Existing tests remain green under `VITE_WIL_ONLY=true` and under hybrid mode.

---

## Rollout Plan

1) Dev only: enable tools for a single profile; JSON-first with WIL fallback; collect metrics.
2) Default profiles: enable tools; keep fallback.
3) CI job: run tests with `VITE_WIL_ONLY=false` + tools; keep existing job with WIL-only to compare.
4) Tools-only (optional flag): enable `VITE_TOOLS_ONLY=true` once coverage is proven.
5) Remove WIL path when JSON success rate/stability meets SLO.

Rollback: set `VITE_WIL_ONLY=true` and/or revert `supportsTools` to false in profiles. No data migrations needed.

---

## Example Payloads

- Planner request (abbrev):
  - messages: `[ { role: 'system', content: <env> }, ...prompt, { role: 'user', content: intent } ]`
  - tools: `[EMIT_PLAN]`, tool_choice: `emit_plan`, response_format: `planSchema`
- Actor request (abbrev): same pattern with `EMIT_BATCH` and plan JSON.
- Tool call delta (OpenAI-style):
  ```json
  { "choices": [ { "delta": { "tool_calls": [ { "index": 0, "id": "call_1", "function": { "name": "emit_batch", "arguments": "{ \n  \"batch\": [ { \"op\": \"window.create\", \"params\": { \"title\": \"Notes\" } } ]\n}" } } ] } } ] }
  ```
  Aggregation: concatenate `function.arguments` by index, parse once complete, then `validateBatch()`.

---

## Differences vs WIL

- Pros
  - Strict contract at model boundary; fewer ad-hoc sanitization steps.
  - Easier differential testing and golden snapshots.
- Cons
  - Tool calling reliability varies by model/vendor; hybrid fallback advisable.
  - Streaming partial JSON requires careful assembly; don’t apply until complete.

---

## Guardrails & Error Codes

- Always fail loud; no empty/broad catches.
- Use error codes with context: prefix `E-UICP-####` where applicable.
- Planner/Actor retries: at most one retry with `buildStructuredRetryMessage()`.
- Backend errors surface to UI with code/status; see `emit_problem_detail()` in `uicp/src-tauri/src/main.rs`.

---

## Implementation Checklist

- [ ] Flip `supportsTools: true` on chosen profiles in `uicp/src/lib/llm/profiles.ts`.
- [x] Add tool-args collector (by index) for planner/actor streams. (`collectToolArgs.ts`, `collectWithFallback.ts`)
- [x] Update `planWithProfile`/`actWithProfile` to JSON-first; keep fallbacks. (orchestrator.ts updated)
- [ ] Extend aggregator to accept `json` channel or tool-call final args; gate by capability. (deferred - needs bridge work)
- [x] Add source metrics (planner/actor: tool|json|text) to the UI debug bus. (`channelUsed` field in results)
- [ ] Update prompts copy to mention tool calling when enabled; keep WIL prompts for fallback.
- [x] Add tests listed above; keep WIL tests. (15 new tests, 176/179 total passing)
- [ ] Add CI matrix jobs: WIL-only and Hybrid.
- [ ] Document `FALLBACK_CLOUD_MODEL` and env flags in README/User Guide.
- [ ] Decide go/no-go for `VITE_TOOLS_ONLY` once metrics are healthy.

---

## Quick Commands

- Run unit tests: `cd uicp && npm run test`
- Focused test (example): `./node_modules/.bin/vitest run tests/unit/ollama/error-propagation.test.ts`
- Dev: set `FALLBACK_CLOUD_MODEL` and `VITE_WIL_ONLY=false` in `.env` (restart Vite/Tauri dev server).

---

## Notes

- Keep the WIL path until JSON success rate is proven with metrics and tests.
- Avoid dual-mode ambiguity in prompts: be explicit per profile (tools-on vs WIL).
- Ensure streaming cancel/timeout paths are symmetric across JSON and WIL.

