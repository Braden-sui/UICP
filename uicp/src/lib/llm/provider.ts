import type { ToolSpec } from './ollama';
import { streamOllamaCompletion } from './ollama';
import {
  getActorProfile,
  getPlannerProfile,
  type ActorProfileKey,
  type PlannerProfileKey,
} from './profiles';

export type LLMStream = ReturnType<typeof streamOllamaCompletion>;

export type PlannerStreamOptions = {
  model?: string;
  tools?: ToolSpec[];
  profileKey?: PlannerProfileKey;
};

export type ActorStreamOptions = {
  model?: string;
  tools?: ToolSpec[];
  profileKey?: ActorProfileKey;
};

export type PlannerClient = {
  streamIntent: (intent: string, options?: PlannerStreamOptions) => LLMStream;
};

export type ActorClient = {
  streamPlan: (planJson: string, options?: ActorStreamOptions) => LLMStream;
};

export function getPlannerClient(): PlannerClient {
  return {
    streamIntent: (intent, options) => {
      const profile = getPlannerProfile(options?.profileKey);
      const messages = profile.formatMessages(intent, { tools: options?.tools });
      const model = options?.model ?? profile.defaultModel;
      return streamOllamaCompletion(messages, model, options?.tools);
    },
  };
}

export function getActorClient(): ActorClient {
  return {
    streamPlan: (planJson, options) => {
      const profile = getActorProfile(options?.profileKey);
      const messages = profile.formatMessages(planJson, { tools: options?.tools });
      const model = options?.model ?? profile.defaultModel;
      return streamOllamaCompletion(messages, model, options?.tools);
    },
  };
}
