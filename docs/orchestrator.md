# Orchestrator: Planner + Actor

Last updated: 2025-10-26

Purpose: authoritative overview of the planner/actor orchestrator, profiles, timeouts, tool modes, and outputs.

Primary files
- Orchestrator: `uicp/src/lib/llm/orchestrator.ts`
- Provider clients: `uicp/src/lib/llm/provider.ts`
- Profiles: `uicp/src/lib/llm/profiles.ts`
- Agents loader (YAML mode): `uicp/src/lib/agents/loader.ts`, `uicp/src/lib/agents/schema.ts`, `uicp/src/lib/agents/preflight.ts`
- Parsing and collection: `uicp/src/lib/llm/collectWithFallback.ts`, `uicp/src/lib/llm/collectToolArgs.ts`, `uicp/src/lib/llm/jsonParsing.ts`, `uicp/src/lib/wil/batch.ts`
- Telemetry: `uicp/src/lib/telemetry`

Profiles and candidates
- Legacy profiles are resolved from code via `getPlannerProfile/getActorProfile` with sensible default models.
- YAML profiles mode (when `cfg.profilesMode === 'yaml'`) loads `agents.yaml` using the Agents loader, resolves providers/models, and optionally refreshes preflight (`preflight.ts`) to validate credentials/caps.

Timeouts and budgets
- Planner timeout (ms): `VITE_PLANNER_TIMEOUT_MS` (defaults derived from mode).
- Actor timeout (ms): `VITE_ACTOR_TIMEOUT_MS` (defaults derived from mode).
- Default max tokens: `VITE_DEFAULT_MAX_TOKENS` (fallback; subject to profile and candidate limits).
- The effective `max_tokens` budget is computed from (profile cap, defaults cap, candidate.limits).

Tool vs. text/WIL modes
- Planner output contracts:
  - Tool mode: call `emit_plan` exactly once with JSON `{ "summary": string, "batch": [] }`.
  - Text mode: plain sections (Summary, Steps, Risks, ActorHints) — no JSON.
- Actor output contracts:
  - Tool mode: call `emit_batch` exactly once with JSON `{ "batch": [...] }`.
  - WIL mode: emit WIL lines (one command per line); no JSON, no prose.
- The orchestrator uses `collectWithFallback` to parse tool outputs or, in non-tool modes, `parseWilToBatch` + `normalizeBatchJson`.

Error handling (stable codes)
- Timeouts and parse failures are surfaced via `LLMError` (see docs/errors.md), e.g. `E-UICP-0100` (tool collection timeout) and `E-UICP-0101` (tool args parse failed).
- Retry messaging is structured to instruct the model to correct format precisely (see `buildStructuredRetryMessage`).

Task spec
- `generateTaskSpec` can produce a `TaskSpec` (uicp/src/lib/llm/schemas.ts) for richer planning; returned on success.

Telemetry and catalog hints
- Telemetry events record start/finish of planning/acting and tool parsing outcomes.
- The orchestrator builds a short catalog summary (available components and tool registry) to guide the model toward `component.render` over raw DOM ops where possible.

Outputs
- `planWithProfile` returns `{ plan, channelUsed?, selectedModel? }`.
- The main run returns `{ plan, batch, traceId, timings, channels?, autoApply?, failures?, taskSpec?, models? }`.

## Examples

Planner tool output (emit_plan):

```
<tool_call name="emit_plan">{"summary":"Short plan","batch":[{"op":"window.create","params":{"title":"Hello"}}]}</tool_call>
```

Actor tool output (emit_batch):

```
<tool_call name="emit_batch">{"batch":[{"op":"dom.set","params":{"windowId":"main","target":"#root","html":"<p>hi</p>"}}]}</tool_call>
```

WIL mode (actor):

```
window.create id=main title="Hello"
dom.set window=main target="#root" html="<p>hi</p>"
```
