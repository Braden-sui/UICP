import type { ToolSpec, StreamEvent, StreamMeta } from './ollama';
import { streamOllamaCompletion } from './ollama';
import {
  getActorProfile,
  getPlannerProfile,
  type ActorProfileKey,
  type PlannerProfileKey,
  type ReasoningEffort,
} from './profiles';
import { buildEnvironmentSnapshot } from '../env';
import { EMIT_PLAN, EMIT_BATCH, planSchema, batchSchema } from './tools';
import type { TaskSpec } from './schemas';
import { useAppStore } from '../../state/app';

export type LLMStream = AsyncIterable<StreamEvent>;

export type PlannerStreamOptions = {
  model?: string;
  tools?: ToolSpec[];
  toolChoice?: unknown;
  profileKey?: PlannerProfileKey;
  extraSystem?: string;
  responseFormat?: unknown;
  meta?: StreamMeta;
  mode?: 'plan' | 'taskSpec';
  taskSpec?: TaskSpec;
  toolSummary?: string;
  reasoningEffort?: ReasoningEffort;
};

export type ActorStreamOptions = {
  model?: string;
  tools?: ToolSpec[];
  toolChoice?: unknown;
  profileKey?: ActorProfileKey;
  extraSystem?: string;
  responseFormat?: unknown;
  meta?: StreamMeta;
  reasoningEffort?: ReasoningEffort;
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
      const mode = options?.mode ?? 'plan';
      const baseSupportsTools = profile.capabilities?.supportsTools !== false;
      const supportsTools = mode !== 'taskSpec' && baseSupportsTools;
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
        mode,
        ...options?.meta,
      };
      const messages = (() => {
        if (mode === 'taskSpec' && typeof profile.formatTaskSpecMessages === 'function') {
          return [
            { role: 'system', content: env },
            ...profile.formatTaskSpecMessages(intent, {
              toolSummary: options?.toolSummary ?? '',
            }),
          ];
        }
        return [
          { role: 'system', content: env },
          ...profile.formatMessages(intent, {
            tools,
            taskSpec: options?.taskSpec,
            toolSummary: options?.toolSummary,
          }),
        ];
      })();
      if (options?.extraSystem) {
        messages.push({ role: 'system', content: options.extraSystem });
      }
      const model = options?.model;
      if (!model) {
        throw new Error('Planner model not specified. Provide model via options.model or choose a profile in Agent Settings.');
      }
      const isGptOss = typeof model === 'string' && model.startsWith('gpt-oss');
      const plannerEffort =
        options?.reasoningEffort ??
        (isGptOss ? useAppStore.getState().plannerReasoningEffort : undefined);
      const reasoningPayload = plannerEffort ? { effort: plannerEffort } : undefined;
      // Force JSON-mode responses so downstream schema validation never sees prose.
      // Provide OpenAI-compatible response_format as a hint for local daemons.
      const requestOptions: Parameters<typeof streamOllamaCompletion>[3] = {
        format,
        responseFormat,
        toolChoice,
        meta,
      };
      if (isGptOss && reasoningPayload) {
        requestOptions.reasoning = reasoningPayload;
        requestOptions.ollamaOptions = { reasoning: reasoningPayload };
      }
      return streamOllamaCompletion(messages, model, tools, requestOptions);
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
      const model = options?.model;
      if (!model) {
        throw new Error('Actor model not specified. Provide model via options.model or choose a profile in Agent Settings.');
      }
      const isGptOss = typeof model === 'string' && model.startsWith('gpt-oss');
      const actorEffort =
        options?.reasoningEffort ?? (isGptOss ? useAppStore.getState().actorReasoningEffort : undefined);
      const reasoningPayload = actorEffort ? { effort: actorEffort } : undefined;
      // Request JSON-mode responses only when tool calling is enabled, otherwise allow free-form WIL text.
      const requestOptions: Parameters<typeof streamOllamaCompletion>[3] = {
        format,
        responseFormat,
        toolChoice,
        meta,
      };
      if (isGptOss && reasoningPayload) {
        requestOptions.reasoning = reasoningPayload;
        requestOptions.ollamaOptions = { reasoning: reasoningPayload };
      }
      return streamOllamaCompletion(messages, model, tools, requestOptions);
    },
  };
}
