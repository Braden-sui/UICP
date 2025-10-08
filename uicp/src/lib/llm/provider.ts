import type { ToolSpec, StreamEvent } from './ollama';
import { streamOllamaCompletion } from './ollama';
import { getActorProfile, getPlannerProfile, type ActorProfileKey, type PlannerProfileKey } from './profiles';

export type LLMStream = AsyncIterable<StreamEvent>;

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
    streamIntent: (intent: string, options?: PlannerStreamOptions) => {
      const profile = getPlannerProfile(options?.profileKey);
      // Profile formatting keeps planner prompts aligned with the selected model contract.
      const messages = profile.formatMessages(intent, { tools: options?.tools });
      const model = options?.model ?? profile.defaultModel;
      return streamOllamaCompletion(messages, model, options?.tools);
    },
  };
}

export function getActorClient(): ActorClient {
  return {
    streamPlan: (planJson: string, options?: ActorStreamOptions) => {
      const profile = getActorProfile(options?.profileKey);
      // Actor profiles encapsulate templating so downstream consumers get consistent outputs.
      const messages = profile.formatMessages(planJson, { tools: options?.tools });
      const model = options?.model ?? profile.defaultModel;
      return streamOllamaCompletion(messages, model, options?.tools);
    },
  };
}
