import type { ChatMessage, ToolSpec } from './ollama';
import { streamOllamaCompletion } from './ollama';
import plannerPrompt from '../../prompts/planner.txt?raw';
import actorPrompt from '../../prompts/actor.txt?raw';

export type LLMStream = ReturnType<typeof streamOllamaCompletion>;

export type PlannerClient = {
  streamIntent: (intent: string, options?: { model?: string; tools?: ToolSpec[] }) => LLMStream;
};

export type ActorClient = {
  streamPlan: (planJson: string, options?: { model?: string; tools?: ToolSpec[] }) => LLMStream;
};

// Planner uses the DeepSeek system prompt. The backend selects cloud/local and models by default when model is undefined.
export function getPlannerClient(): PlannerClient {
  return {
    streamIntent: (intent, options) => {
      const messages: ChatMessage[] = [
        { role: 'system', content: plannerPrompt.trim() },
        { role: 'user', content: intent },
      ];
      return streamOllamaCompletion(messages, options?.model, options?.tools);
    },
  };
}

// Actor uses the Kimi system prompt. The backend selects cloud/local and models by default when model is undefined.
export function getActorClient(): ActorClient {
  return {
    streamPlan: (planJson, options) => {
      const messages: ChatMessage[] = [
        { role: 'system', content: actorPrompt.trim() },
        { role: 'user', content: planJson },
      ];
      return streamOllamaCompletion(messages, options?.model, options?.tools);
    },
  };
}

