export type ProviderCapabilities = {
  supportsTools?: boolean;
  supportsJsonMode?: boolean;
  requiresMaxTokens?: boolean;
  maxTokensLimit?: number;
  authType?: 'bearer' | 'x-api-key' | 'none';
  supportsSystemTopLevel?: boolean;
  rateLimits?: Record<string, unknown>;
};

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

export type ChatUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

export type ChatResponseMeta = {
  provider?: string;
  model?: string;
  requestId?: string;
};

export type ChatResponse = {
  usage?: ChatUsage;
  provider_meta?: ChatResponseMeta;
};
