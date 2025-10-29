import { streamOllamaCompletion, type ChatMessage, type ToolSpec, type StreamEvent } from './llm.stream';

// NOTE: Keep this file minimal initially; the router provides a seam to delegate
// to provider-specific backends. When VITE_STREAM_V1 is enabled and server-side
// normalization is available, this router can switch to a generic path.

// Infer the request options type from streamOllamaCompletion to avoid duplication.
export type RouterRequestOptions = Parameters<typeof streamOllamaCompletion>[3];

export const route = (
  messages: ChatMessage[],
  model: string,
  tools?: ToolSpec[],
  options?: RouterRequestOptions,
): AsyncIterable<StreamEvent> => {
  // V1 router: direct delegation to current streaming path.
  // Future: switch based on options?.provider and enable normalized streams.
  return streamOllamaCompletion(messages, model, tools, options);
};
