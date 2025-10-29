// Provider-specific recorded-like fixtures for normalization tests
// These are minimal shapes representative of each provider's streaming chunks.

export const openaiDeltaContent = {
  choices: [
    {
      delta: {
        content: 'Hello',
      },
    },
  ],
};

export const openrouterDeltaToolCalls = {
  choices: [
    {
      delta: {
        tool_calls: [
          {
            index: 0,
            id: 'call_0',
            function: { name: 'emit_batch', arguments: '{"batch":[]}' },
          },
        ],
      },
    },
  ],
};

// Note: backend anthropic::normalize_message converts SSE events into this OpenAI-like shape.
export const anthropicNormalizedTextDelta = {
  choices: [
    {
      delta: {
        content: [{ type: 'text', text: 'Hello' }],
      },
    },
  ],
};

export const anthropicNormalizedToolUseStart = {
  choices: [
    {
      delta: {
        tool_calls: [
          {
            index: 0,
            id: 'tool_abc',
            name: 'run_cmd',
            function: { name: 'run_cmd', arguments: '{"cmd":"echo hi"}' },
          },
        ],
      },
    },
  ],
};

// Ollama can output raw text lines; aggregator path treats them as kind:"text"
export const ollamaTextLine = 'status: loading model';
