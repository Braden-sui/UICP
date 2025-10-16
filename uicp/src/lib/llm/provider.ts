import type { ToolSpec, StreamEvent, StreamMeta } from './ollama';
import { streamOllamaCompletion } from './ollama';
import { getActorProfile, getPlannerProfile, type ActorProfileKey, type PlannerProfileKey } from './profiles';
import { buildEnvironmentSnapshot } from '../env';
import { EMIT_PLAN, EMIT_BATCH, planSchema, batchSchema } from './tools';

export type LLMStream = AsyncIterable<StreamEvent>;

export type PlannerStreamOptions = {
  model?: string;
  tools?: ToolSpec[];
  toolChoice?: unknown;
  profileKey?: PlannerProfileKey;
  extraSystem?: string;
  responseFormat?: unknown;
  meta?: StreamMeta;
};

export type ActorStreamOptions = {
  model?: string;
  tools?: ToolSpec[];
  toolChoice?: unknown;
  profileKey?: ActorProfileKey;
  extraSystem?: string;
  responseFormat?: unknown;
  meta?: StreamMeta;
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
      const tools = supportsTools ? options?.tools ?? [EMIT_PLAN] : undefined;
      const toolChoice = supportsTools
        ? options?.toolChoice ?? { type: 'function', function: { name: 'emit_plan' } }
        : undefined;
      const responseFormat = supportsTools
        ? options?.responseFormat ?? {
            type: 'json_schema',
            json_schema: { name: 'uicp_plan', schema: planSchema },
          }
        : undefined;
      const format = supportsTools ? 'json' : undefined;
      const meta: StreamMeta = {
        role: 'planner',
        profileKey: profile.key,
        ...options?.meta,
      };
      const messages = [
        // Prepend a compact environment snapshot to improve context-awareness.
        { role: 'system', content: env },
        ...profile.formatMessages(intent, { tools }),
      ];
      if (options?.extraSystem) {
        messages.push({ role: 'system', content: options.extraSystem });
      }
      const model = options?.model ?? profile.defaultModel;
      // Force JSON-mode responses so downstream schema validation never sees prose.
      // Provide OpenAI-compatible response_format as a hint for local daemons.
      return streamOllamaCompletion(messages, model, tools, {
        format,
        responseFormat,
        toolChoice,
        meta,
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
      const tools = supportsTools ? options?.tools ?? [EMIT_BATCH] : undefined;
      const toolChoice = supportsTools
        ? options?.toolChoice ?? { type: 'function', function: { name: 'emit_batch' } }
        : undefined;
      const responseFormat = supportsTools
        ? options?.responseFormat ?? {
            type: 'json_schema',
            json_schema: { name: 'uicp_batch', schema: batchSchema },
          }
        : undefined;
      const format = supportsTools ? 'json' : undefined;
      const meta: StreamMeta = {
        role: 'actor',
        profileKey: profile.key,
        ...options?.meta,
      };
      const messages = [
        { role: 'system', content: env },
        ...profile.formatMessages(planJson, { tools }),
      ];
      if (options?.extraSystem) {
        messages.push({ role: 'system', content: options.extraSystem });
      }
      const model = options?.model ?? profile.defaultModel;
      // Request JSON-mode responses only when tool calling is enabled, otherwise allow free-form WIL text.
      return streamOllamaCompletion(messages, model, tools, {
        format,
        responseFormat,
        toolChoice,
        meta,
      });
    },
  };
}
