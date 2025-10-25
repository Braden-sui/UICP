# JSON Tool Calling Reference (UICP)

Purpose: Migrate planner/actor from WIL text to JSON tool calling with safe fallbacks, observability, and tests. This is the authoritative checklist and spec for the transition.

Status: Planner = tool-first (JSON) with cascaded fallbacks. Actor = tool-first (JSON) with JSON text and WIL text fallbacks; orchestrator enforces a spawn guarantee so users never see a blank desktop.

---

## Overview

- Tools and schemas live in `uicp/src/lib/llm/tools.ts`.
- Transport uses the existing Tauri streaming channel `ollama-completion` from `uicp/src-tauri/src/main.rs`.
- Frontend stream listener is `uicp/src/lib/llm/ollama.ts`.
- Planner/Actor orchestrator is `uicp/src/lib/llm/orchestrator.ts`.
- Provider wiring (messages, tools, response_format) is `uicp/src/lib/llm/provider.ts`.
- Streaming aggregator is `uicp/src/lib/uicp/stream.ts` (supports tools + json + WIL in priority order).

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
  - Spawn guarantee: if Actor emits no visible effect (no `window.create` and no `dom.*`/`component.*`), the orchestrator injects a safe
    `window.create` + `dom.set` so DockChat always shows a window.
- Invariants
  - `op` must be a valid operation.
  - `batch` validates with `validateBatch()` (`uicp/src/lib/uicp/schemas.ts` → frozen in `uicp/src/lib/schema/index.ts`).
  - Fail loud on schema mismatch (no silent drop).

---

## Environment Flags

- `VITE_WIL_ONLY` (boolean)
  - true → Planner uses the text-only path (no tool calls); Actor remains JSON-first; aggregator still buffers commentary for WIL parsing.
  - false → JSON-first with cascaded fallbacks (tool → json → WIL).
- `VITE_PLANNER_MODEL` (string)
  - Model identifier used by the planner client (e.g., `deepseek-v3.1:671b`, `glm-4.6:cloud`).
- `VITE_ACTOR_MODEL` (string)
  - Model identifier used by the actor client (e.g., `qwen3-coder:480b`, `glm-4.6:cloud`).
- `FALLBACK_CLOUD_MODEL`
  - e.g., `kimi-k2:1t`; used by backend on 4xx/5xx to retry once with an alternate model.
- Proposed (optional future)
  - `VITE_TOOLS_ONLY` (boolean): if true, disallow WIL fallback (enable only after JSON path is fully proven).

---

## Profiles (capability-based, model-agnostic)

- File: `uicp/src/lib/llm/profiles.ts`
- Profiles define capabilities (channels, tool support) and prompt formatting only; they are completely model-agnostic.
- Model selection is handled at runtime via `options.model` parameter passed to `streamIntent()` and `streamPlan()`.
- Planner profiles: `glm`, `gpt-oss`, `deepseek`, `kimi`, `qwen` support tools; `wil` is text-only.
- Actor profiles: `glm`, `gpt-oss`, `qwen`, `kimi`, `deepseek` support tools.

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

## Tool Registry (MCP-ish)

- LLM functions (visible to models)
  - `emit_plan` (schema = `planSchema`)
  - `emit_batch` (schema = `batchSchema`)
  - Source: `uicp/src/lib/llm/tools.ts`, registry: `uicp/src/lib/llm/registry.ts`
- Local operations (executed by adapter)
  - window: `window.create`, `window.update`, `window.close` (risk: low)
  - dom: `dom.set`, `dom.replace`, `dom.append` (risk: low; sanitized and size-capped)
  - component: `component.render|update|destroy` (risk: low; allowed types only)
  - state: `state.set|get|watch|unwatch` (risk: low; local only)
  - txn: `txn.cancel` (risk: low)
- api: `api.call` (risk: medium; permission-gated)
- Source: `uicp/src/lib/uicp/schemas.ts`, registry: `uicp/src/lib/llm/registry.ts`

---

## Prompts (tool-only contract)

- Planner prompt (`uicp/src/prompts/planner.txt`)
  - Explicitly instructs the model to call `emit_plan` once, produce `{ "summary": "...", "batch": [] }`, and to use `gui:` risks / actor hints for execution guidance.
- Actor prompt (`uicp/src/prompts/actor.txt`)
  - Forces a single `emit_batch` invocation with fully qualified envelopes.
  - Forbids WIL or plain text responses and highlights visible UI requirements (e.g., include `window.create` and `dom.set`).

These prompts are treated as source of truth; any deviation is caught by orchestrator retries.

---

## Permissions (pilot)

- Manager: `uicp/src/lib/permissions/PermissionManager.ts`
- Allow-list: window/dom/component/state/txn
- api.call: allowed for `uicp://`, `tauri://`, `http(s)` and `localhost` in dev; future UI prompt will persist allow/deny per origin+method
- Unknown ops: deny by default

---

## Orchestrator (Tool-first)

- File: `uicp/src/lib/llm/orchestrator.ts`
- Planner (`planWithProfile`):
  1) If the selected profile supports tools, collect the `emit_plan` tool call.
  2) If missing, attempt JSON parse from text content; if still missing, fall back to outline parsing (Summary/Steps/Risks/ActorHints).
  3) On schema issues we retry once with a structured system message reiterating the contract.
- Actor (`actWithProfile`):
  1) Prefer a valid `emit_batch` tool call and validate.
  2) If missing, attempt JSON parse from text; if still missing, parse WIL text.
  3) If nothing actionable after fallback, emit a structured retry message; on final failure, inject the spawn-guarantee `window.create` + `dom.set`.
- Clarifier flow and metadata stamping remain unchanged.

---

## Streaming Aggregator (Apply path)

- Current: ``uicp/src/lib/uicp/stream.ts`` accumulates in priority order and applies on flush.
  - Tool-first: accumulate ``tool_call`` deltas for ``emit_batch``, merge segments, then normalise via ``normalizeBatchJson()``.
  - JSON channel: accumulate ``json`` channel text as a structured secondary path.
  - Commentary/text: always buffer and parse as WIL fallback at flush.
- Bridge integration: ``uicp/src/lib/bridge/tauri.ts`` uses this aggregator; cancellation and error propagation are unchanged.

---

## Backend Transport & Errors

- File: `uicp/src-tauri/src/main.rs`
  - Emits `ollama-completion` SSE-like events.
  - Event naming: backend normalizes event names by replacing `.` with `-`. Prefer dashed names in new code and listeners.
  - On upstream errors: sends `{ done: true, error: { status, code, detail, requestId, retryAfterMs? } }`.
- File: `uicp/src/lib/llm/ollama.ts`
  - On `payload.done && payload.error`, now fails the queue (no silent completion) and ends the stream.
  - Emits `llm_error` and `llm_complete` with context.

---

## Observability (what to log/track)

- UI Debug events (frontend): `ui-debug-log`
  - Request lifecycle: `llm_request_started`, `llm_delta`, `llm_complete`, `llm_error`.
  - Sources recorded on orchestrator finish events:
    - `channels.planner = tool | json | json-fallback | text | text-fallback`
    - `channels.actor = tool | json-fallback | text | text-fallback`
  - Telemetry events of interest (frontend):
    - `planner_start` / `planner_finish` with `{ traceId, durationMs, channel, fallback, summary }`
    - `actor_start` / `actor_finish` with `{ traceId, durationMs, channel, batchSize, plannerFallback }`
    - `tool_args_parsed` with `{ span, status, reason, target, attempt, preview? }`
    - `collect_timeout` with `{ span, targetToolName, timeoutMs }`
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

## Implementation Status

**Architecture Decision: JSON-first with cascaded fallbacks enabled by default**

- Default profiles provide tools; planner/actor attempt tool calls first.
- Aggregator accepts all channels: tool calls, JSON, and WIL text.
- Profile `supportsTools` controls which tools are provided to the model.
- `VITE_WIL_ONLY` (when enabled) forces planner text-only; actor remains JSON-first; aggregator remains unchanged.
- Fallback chain: tool call → JSON content → WIL text → error.

**Completed:**
- [x] Tool-args collector for planner/actor streams (`collectToolArgs.ts`, `collectWithFallback.ts`)
- [x] Orchestrator always uses JSON-first with cascading fallbacks
- [x] Aggregator accepts all channels (tools, json, wil) without gating
- [x] Source metrics (`channelUsed` field tracks: tool|json|text)
- [x] Prompts emphasize tool calling; WIL prompt for `wil` profile
- [x] Tests cover tool collection and fallback paths

**Deferred:**
- [ ] Add CI matrix jobs for different profiles


## Quick Commands

- Run unit tests: `cd uicp && pnpm run test`
- Focused test (example): `./node_modules/.bin/vitest run tests/unit/ollama/error-propagation.test.ts`
- Dev: Tool calling is always enabled; use `VITE_PLANNER_MODEL` and `VITE_ACTOR_MODEL` to select models.

---

## Notes

- Keep the WIL path until JSON success rate is proven with metrics and tests.
- Avoid dual-mode ambiguity in prompts: be explicit per profile (tools-on vs WIL).
- Ensure streaming cancel/timeout paths are symmetric across JSON and WIL.

---

## Appendix: PR Description Template (JSON-first changes)

PLAN

- Goal and why now
- Key assumptions and confidence
- Selected Tier and rationale; rollback plan

DIFF SUMMARY

- What changed (orchestrator, provider, prompts, aggregator)
- Deleted code inventory (if any)

VALIDATION

- Tests added/updated and what they prove (tool, JSON fallback, WIL fallback)
- Manual steps (if any)
- Observability added (events, `channelUsed` tracking)
