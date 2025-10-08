import type { ChatMessage, ToolSpec, StreamEvent } from '../ollama';

export type ChatRequest = {
  messages: ChatMessage[];
  model?: string;
  tools?: ToolSpec[];
  options?: Record<string, unknown>;
};

export interface ModelAdapter {
  chat(input: ChatRequest): AsyncIterable<StreamEvent>;
}
