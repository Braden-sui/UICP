# LLM Chat Protocol v1

Last updated: 2025-10-28

## Purpose
Define a single, provider-agnostic request/response contract for chat completions used by planner/actor. This separates profile formatting from transport quirks, centralizes provider transforms, and enables stronger testing and diagnostics.

## Versioning
- Identifier: Chat Protocol v1
- Stability: Beta behind flag `VITE_CHAT_PROTOCOL_V1`
- Backward compatibility: v1 is a superset of current inputs; provider transforms handle differences

## Request
```ts
export type ChatMessage = { role: string; content: string | Record<string, unknown> };
export type ChatRequest = {
  provider?: string;
  base_url?: string;
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: unknown;
  max_tokens?: number;
  reasoning?: { effort: 'low' | 'medium' | 'high' };
  metadata?: Record<string, unknown>;
};
```

Guidance:
- roles: system|user|assistant|tool (+ provider-mapped variants)
- messages may include structured JSON in `content`
- `response_format` is OpenAI-compatible hint; ignored where unsupported
- `reasoning` is an optional hint honored by providers that support it

## Response (streamed)
- Streamed as normalized StreamEvent v1 (see Stream Event v1 doc)
- Final usage and meta included in terminal envelope
```ts
export type ChatResponse = {
  usage?: { inputTokens?: number; outputTokens?: number };
  provider_meta?: { provider?: string; model?: string; requestId?: string };
};
```

## ProviderCapabilities
```ts
export type ProviderCapabilities = {
  supportsTools?: boolean;
  supportsJsonMode?: boolean;
  requiresMaxTokens?: boolean;
  maxTokensLimit?: number;
  authType?: 'bearer' | 'x-api-key' | 'none';
  supportsSystemTopLevel?: boolean;
  rateLimits?: Record<string, unknown>;
};
```

## Mapping Tables (Requests)

### OpenAI (api.openai.com/v1)
- Endpoint: POST /chat/completions
- Auth: Authorization: Bearer $OPENAI_API_KEY
- Request mapping:
  - model: passthrough
  - messages: passthrough
  - tools/tool_choice: passthrough
  - response_format: passthrough
  - max_tokens: passthrough
  - system: as role="system" message (top-level system unsupported)

### OpenRouter (openrouter.ai/api/v1)
- Endpoint: POST /chat/completions
- Auth: Authorization: Bearer $OPENROUTER_API_KEY (+ X-Title, Referer optional)
- Request mapping: same as OpenAI
- model: provider/model-name format

### Anthropic (api.anthropic.com)
- Endpoint: POST /v1/messages
- Auth: x-api-key: $ANTHROPIC_API_KEY
- Request mapping:
  - system: extracted from messages[role=system] → top-level `system`
  - messages: remove role=system entries; map unsupported roles (developer→user)
  - max_tokens: required (default if missing)
  - response_format/format/stream: dropped (not supported in body)
  - tool result field rename: tool_call_id→tool_use_id

### Ollama Cloud (ollama.com)
- Endpoint: POST /api/chat
- Auth: Authorization: Bearer $OLLAMA_API_KEY
- Request mapping:
  - model: plain id (no :cloud suffix)
  - messages/tools/tool_choice: passthrough
  - response_format: optional; tolerated
  - max_tokens: passthrough (also copied into options.num_predict when available)

### Ollama Local (localhost:11434)
- Endpoint: POST /api/chat (cloud-compatible), or /chat/completions (local path)
- Auth: none
- Request mapping: similar to Ollama Cloud; no auth

## Examples

OpenAI-like request:
```json
{
  "provider": "openai",
  "model": "gpt-4o",
  "messages": [
    { "role": "system", "content": "You are a planner." },
    { "role": "user", "content": "Build a counter app." }
  ],
  "tools": [{ "type": "function", "function": { "name": "emit_plan", "parameters": {"type":"object"} } }],
  "tool_choice": { "type": "function", "function": { "name": "emit_plan" } },
  "response_format": { "type": "json_schema", "json_schema": { "name": "uicp_plan", "schema": {"type":"object"} } },
  "max_tokens": 4096
}
```

Anthropic-mapped (effective body after transform):
```json
{
  "model": "claude-sonnet-4.5",
  "system": "You are a planner.",
  "messages": [ { "role": "user", "content": "Build a counter app." } ],
  "max_tokens": 4096,
  "tools": [ /* mapped tools */ ],
  "tool_choice": { /* mapped choice */ }
}
```

## Invariants
- Profiles remain model-agnostic; capabilities are discovered per provider
- Provider adapters perform all schema transforms server-side
- Frontend emits a single ChatRequest per turn and consumes normalized streams

## Related
- Stream Event v1 (normalization and examples)
- ProblemDetail v1 (error taxonomy and mapping)
