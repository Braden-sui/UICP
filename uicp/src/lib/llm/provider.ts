import type { ToolSpec, StreamEvent, ChatMessage } from './ollama';
import { streamOllamaCompletion } from './ollama';
import {
  getActorProfile,
  getPlannerProfile,
  type ActorProfileKey,
  type PlannerProfileKey,
} from './profiles';
import { OssHarmonyAdapter } from './adapters/oss-harmony-adapter';
import type { ModelAdapter } from './adapters/types';

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

const readEnvString = (key: string): string | undefined => {
  try {
    const raw = (import.meta as unknown as { env?: Record<string, unknown> }).env?.[key];
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
};

const OSS_DEFAULT_ENDPOINT = 'https://ollama.com/v1/chat/completions';
const OSS_ENDPOINT = readEnvString('VITE_GPT_OSS_ENDPOINT') ?? OSS_DEFAULT_ENDPOINT;
const OSS_API_KEY = readEnvString('VITE_GPT_OSS_API_KEY');
const OSS_DEBUG = readEnvString('VITE_GPT_OSS_DEBUG') === '1';

let ossHarmonyAdapter: ModelAdapter | null = null;
// Harmony profiles rely on the incremental decoder path; legacy profiles fall back to Ollama streaming.
const ensureOssHarmonyAdapter = (): ModelAdapter => {
  if (!ossHarmonyAdapter) {
    ossHarmonyAdapter = new OssHarmonyAdapter({
      endpoint: OSS_ENDPOINT,
      apiKey: OSS_API_KEY,
      debug: OSS_DEBUG ? (frame) => console.debug('[oss-harmony frame]', frame) : undefined,
    });
  }
  return ossHarmonyAdapter;
};

const streamWithProfile = (
  adapter: ModelAdapter | null,
  messages: ChatMessage[],
  model: string | undefined,
  tools: ToolSpec[] | undefined,
): LLMStream => {
  if (adapter) {
    return adapter.chat({ messages, model, tools });
  }
  return streamOllamaCompletion(messages, model, tools);
};

export function getPlannerClient(): PlannerClient {
  return {
    streamIntent: (intent: string, options?: PlannerStreamOptions) => {
      const profile = getPlannerProfile(options?.profileKey);
      const messages = profile.formatMessages(intent, { tools: options?.tools });
      const model = options?.model ?? profile.defaultModel;
      const adapter = profile.responseMode === 'harmony' ? ensureOssHarmonyAdapter() : null;
      return streamWithProfile(adapter, messages, model, options?.tools);
    },
  };
}

export function getActorClient(): ActorClient {
  return {
    streamPlan: (planJson: string, options?: ActorStreamOptions) => {
      const profile = getActorProfile(options?.profileKey);
      const messages = profile.formatMessages(planJson, { tools: options?.tools });
      const model = options?.model ?? profile.defaultModel;
      const adapter = profile.responseMode === 'harmony' ? ensureOssHarmonyAdapter() : null;
      return streamWithProfile(adapter, messages, model, options?.tools);
    },
  };
}
