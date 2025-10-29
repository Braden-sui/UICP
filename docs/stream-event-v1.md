# Stream Event v1 (Normalization)

Last updated: 2025-10-28

## Purpose
Provide a single, normalized event union produced by all LLM providers so the frontend aggregator and orchestrator do not need provider-specific parsers. This reduces edge cases (e.g., GLM final message.tool_calls) and enables stable telemetry and testing.

## Event Union
```ts
export type StreamContentEvent = { type: 'content'; channel?: string; text: string };
export type StreamToolCallEvent = {
  type: 'tool_call';
  index: number;
  id?: string;
  name?: string;
  arguments: unknown;
  isDelta: boolean;
};
export type StreamReturnEvent = { type: 'return'; channel?: string; name?: string; result: unknown };
export type StreamDoneEvent = { type: 'done' };
export type StreamErrorEvent = { type: 'error'; code: string; detail?: string };

export type StreamEventV1 =
  | StreamContentEvent
  | StreamToolCallEvent
  | StreamReturnEvent
  | StreamDoneEvent
  | StreamErrorEvent;
```

Notes:
- `channel`: one of `json`, `text`, or provider-specific channels mapped to `json`/`text`.
- `tool_call.isDelta`: true when arguments/name arrive incrementally.
- `error.code`: short machine code (e.g., `AuthMissing`, `RateLimited`, `TransportTimeout`).

## Provider Mapping (Examples)

### OpenAI (chat.completions)
Input fragments:
```json
{"choices":[{"delta":{"content":"Hello"}}]}
{"choices":[{"delta":{"tool_calls":[{"id":"call_1","function":{"name":"emit_plan","arguments":"{\"a\":1}"}}]}}]}
```
Normalized:
```json
{"type":"content","channel":"json","text":"Hello"}
{"type":"tool_call","index":0,"id":"call_1","name":"emit_plan","arguments":"{\"a\":1}","isDelta":true}
```

### OpenRouter (OpenAI-compatible)
- Same mapping as OpenAI.

### Anthropic (messages)
Input fragments:
```json
{"type":"message_start","message":{"id":"msg_1"}}
{"type":"content_block_delta","delta":{"type":"output_text_delta","text":"Hi"}}
{"type":"tool_use","id":"tu_1","name":"emit_plan","input":{"a":1}}
```
Normalized:
```json
{"type":"content","channel":"json","text":"Hi"}
{"type":"tool_call","index":0,"id":"tu_1","name":"emit_plan","arguments":{"a":1},"isDelta":false}
```

### Ollama Cloud/Local
Input fragments (NDJSON with mixed text/JSON and provider-tagged kinds):
```json
{"kind":"json","delta":{"choices":[{"delta":{"content":[{"type":"text","text":"Planning"}]}}]}}
{"kind":"json","delta":{"choices":[{"delta":{"tool_calls":[{"name":"emit_plan","arguments":"{\"a\":1}"}]}}]}}
```
Normalized:
```json
{"type":"content","channel":"json","text":"Planning"}
{"type":"tool_call","index":0,"name":"emit_plan","arguments":"{\"a\":1}","isDelta":true}
```

## Terminal Events
- `done`: emitted exactly once at stream completion with success
- `error`: emitted once with a typed code and optional `detail`, followed by `done`

## Invariants
- Every stream ends with either `error` then `done`, or `done` alone.
- Tool calls appear as `tool_call` regardless of provider schema.
- Providers that emit complete tool calls only at final message (e.g., GLM via `message.tool_calls`) must map those to one or more `tool_call` events before completion.

## Testing
- Contract tests assert that adapter outputs only StreamEvent v1 shapes.
- Recorded fixtures validate mapping across providers and regression-proof GLM `message.tool_calls`.

## Related
- LLM Chat Protocol v1 (requests/responses)
- ProblemDetail v1 (error taxonomy)
