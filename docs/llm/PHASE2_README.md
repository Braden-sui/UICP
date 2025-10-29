# Phase 2: Provider Adapters and Router

This document captures how to enable, test, and verify Phase 2 work: server-side normalization, provider router seam, auth preflight, and normalized StreamEvent v1.

## Runtime flags

- Backend
  - UICP_STREAM_V1=1 — emit normalized StreamEvent v1 on `uicp-stream-v1`
- Frontend
  - VITE_STREAM_V1=true — listen on `uicp-stream-v1`
  - VITE_PROVIDER_ROUTER_V1=true — use router seam (and emit provider_decision telemetry)

## Components

- Backend (Rust)
  - Request transforms: Anthropic Messages API mapping (system -> top-level; tool_use_id; require max_tokens)
  - Model normalization: Ollama cloud/local path and `-cloud` suffix handling
  - Header injection: providers.rs builds per-provider auth headers from keystore
  - Auth preflight: `auth_preflight(provider)` returns { ok, code, detail }
  - Stream v1 emission: emits `content`, `tool_call`, `done`, `error` on `uicp-stream-v1` when enabled

- Frontend (TS)
  - Router seam: `uicp/src/lib/llm/router.ts` (delegates to current streamer; switchable via flag)
  - Provider selection telemetry: `provider_decision` emitted when router flag is on
  - Agent Settings: Auth Preflight button, typed status surfacing
  - Extractor: `extractEventsFromChunk()` recognizes OpenAI/OpenRouter/Anthropic-normalized/GLM shapes (incl. message.tool_calls)

## How to validate

1) Auth Preflight
- Agent Settings → select provider → Auth Preflight
- Expected: OK when key present and policy allows; PolicyDenied if permissions block; AuthMissing otherwise; Not applicable for local

2) Normalized StreamEvent v1
- Set UICP_STREAM_V1=1 and VITE_STREAM_V1=true
- Run a planner/actor turn
- Expected: frontend logs show `llm_stream_mode normalized: true` and events arriving on `uicp-stream-v1`

3) Router selection
- Set VITE_PROVIDER_ROUTER_V1=true
- Initiate planner/actor turn
- Expected: telemetry contains `provider_decision` with role, provider, baseUrl, model

## Tests

- Extractor contract
  - `streamEventV1.contract.test.ts`, `extractEventsFromChunk.test.ts`, `fixtures.contract.test.ts`, `anthropicNormalized.contract.test.ts`
  - GLM regression: `message.tool_calls` supported by extractor
- Router telemetry
  - `provider.router.telemetry.test.ts` checks `provider_decision`

## Success criteria

- Frontend receives normalized events behind flag
- Auth preflight surfaced with typed codes and remediation details
- Router emits selection telemetry when enabled

## Notes

- End-to-end tests are optional for this phase per directive; focus is on unit/contract coverage.
