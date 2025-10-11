import type { ToolSpec, StreamEvent } from './ollama';
import { streamOllamaCompletion } from './ollama';
import { getActorProfile, getPlannerProfile, type ActorProfileKey, type PlannerProfileKey } from './profiles';
import { buildEnvironmentSnapshot } from '../env';
import { EMIT_PLAN, EMIT_BATCH } from './tools';

export type LLMStream = AsyncIterable<StreamEvent>;

export type PlannerStreamOptions = {
  model?: string;
  tools?: ToolSpec[];
  toolChoice?: unknown;
  profileKey?: PlannerProfileKey;
};

export type ActorStreamOptions = {
  model?: string;
  tools?: ToolSpec[];
  toolChoice?: unknown;
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
      // Include DOM snapshot by default to maximize context-awareness.
      const env = buildEnvironmentSnapshot({ includeDom: true });
      const supportsTools = profile.capabilities?.supportsTools !== false;
      const tools = supportsTools ? options?.tools ?? [EMIT_PLAN] : options?.tools;
      const toolChoice = supportsTools
        ? options?.toolChoice ?? { type: 'function', function: { name: 'emit_plan' } }
        : options?.toolChoice;
      const messages = [
        // Prepend a compact environment snapshot to improve context-awareness.
        { role: 'system', content: env },
        ...profile.formatMessages(intent, { tools }),
      ];
      const model = options?.model ?? profile.defaultModel;
      // Force JSON-mode responses so downstream schema validation never sees prose.
      // Provide OpenAI-compatible response_format as a hint for local daemons.
      return streamOllamaCompletion(messages, model, tools, {
        format: 'json',
        responseFormat: { type: 'json_object' },
        toolChoice,
      });
    },
  };
}

export function getActorClient(): ActorClient {
  return {
    streamPlan: (planJson: string, options?: ActorStreamOptions) => {
      const profile = getActorProfile(options?.profileKey);
      // Actor profiles encapsulate templating so downstream consumers get consistent outputs.
      const env = buildEnvironmentSnapshot({ includeDom: true });
      const supportsTools = profile.capabilities?.supportsTools !== false;
      const tools = supportsTools ? options?.tools ?? [EMIT_BATCH] : options?.tools;
      const toolChoice = supportsTools
        ? options?.toolChoice ?? { type: 'function', function: { name: 'emit_batch' } }
        : options?.toolChoice;
      const messages = [
        { role: 'system', content: env },
        ...profile.formatMessages(planJson, { tools }),
      ];
      const model = options?.model ?? profile.defaultModel;
      // Actor output must be valid JSON; request strict JSON formatting and provide OpenAI-compatible hint.
      return streamOllamaCompletion(messages, model, tools, {
        format: 'json',
        responseFormat: { type: 'json_object' },
        toolChoice,
      });
    },
  };
}
