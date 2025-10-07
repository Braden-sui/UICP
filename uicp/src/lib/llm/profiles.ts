import plannerPrompt from '../../prompts/planner.txt?raw';
import actorPrompt from '../../prompts/actor.txt?raw';
import type { ChatMessage, ToolSpec } from './ollama';

export type PlannerProfileKey = 'deepseek' | 'gpt-oss';
export type ActorProfileKey = 'qwen' | 'gpt-oss';

export type ResponseMode = 'legacy' | 'harmony';

export interface PlannerProfile {
  key: PlannerProfileKey;
  label: string;
  description: string;
  defaultModel?: string;
  responseMode: ResponseMode;
  capabilities?: { channels: string[]; supportsTools: boolean };
  formatMessages: (intent: string, opts?: { tools?: ToolSpec[] }) => ChatMessage[];
}

export interface ActorProfile {
  key: ActorProfileKey;
  label: string;
  description: string;
  defaultModel?: string;
  responseMode: ResponseMode;
  capabilities?: { channels: string[]; supportsTools: boolean };
  formatMessages: (planJson: string, opts?: { tools?: ToolSpec[] }) => ChatMessage[];
}

const DEFAULT_PLANNER_KEY: PlannerProfileKey = (import.meta.env.VITE_PLANNER_PROFILE as PlannerProfileKey) ?? 'deepseek';
const DEFAULT_ACTOR_KEY: ActorProfileKey = (import.meta.env.VITE_ACTOR_PROFILE as ActorProfileKey) ?? 'qwen';

const plannerProfiles: Record<PlannerProfileKey, PlannerProfile> = {
  deepseek: {
    key: 'deepseek',
    label: 'DeepSeek V3.1',
    description: 'Legacy planner prompt tuned for DeepSeek reasoning mode.',
    responseMode: 'legacy',
    capabilities: { channels: ['commentary'], supportsTools: true },
    defaultModel: undefined,
    formatMessages: (intent) => [
      { role: 'system', content: plannerPrompt.trim() },
      { role: 'user', content: intent },
    ],
  },
  'gpt-oss': {
    key: 'gpt-oss',
    label: 'GPT-OSS (Harmony)',
    description: 'Planner using Harmony response format. Pending full parser integration.',
    responseMode: 'harmony',
    capabilities: { channels: ['analysis', 'commentary', 'final'], supportsTools: true },
    defaultModel: 'gpt-oss-120b-cloud',
    formatMessages: (intent, opts) => [
      {
        role: 'developer',
        content: {
          instructions: plannerPrompt.trim(),
          reasoning_level: 'high',
          tools: opts?.tools ?? [],
        },
      },
      { role: 'user', content: intent },
    ],
  },
};

const actorProfiles: Record<ActorProfileKey, ActorProfile> = {
  qwen: {
    key: 'qwen',
    label: 'Qwen3-Coder 480B',
    description: 'Legacy actor prompt tuned for Qwen tool calling.',
    responseMode: 'legacy',
    capabilities: { channels: ['commentary'], supportsTools: true },
    defaultModel: undefined,
    formatMessages: (planJson) => [
      { role: 'system', content: actorPrompt.trim() },
      { role: 'user', content: planJson },
    ],
  },
  'gpt-oss': {
    key: 'gpt-oss',
    label: 'GPT-OSS (Harmony)',
    description: 'Actor using Harmony response format. Pending full parser integration.',
    responseMode: 'harmony',
    capabilities: { channels: ['analysis', 'commentary', 'final'], supportsTools: true },
    defaultModel: 'gpt-oss-120b-cloud',
    formatMessages: (planJson, opts) => [
      {
        role: 'developer',
        content: {
          instructions: actorPrompt.trim(),
          reasoning_level: 'medium',
          tools: opts?.tools ?? [],
        },
      },
      { role: 'user', content: planJson },
    ],
  },
};

export const listPlannerProfiles = (): PlannerProfile[] => Object.values(plannerProfiles);
export const listActorProfiles = (): ActorProfile[] => Object.values(actorProfiles);

export const getPlannerProfile = (key?: PlannerProfileKey): PlannerProfile => {
  const resolvedKey = key ?? DEFAULT_PLANNER_KEY;
  return plannerProfiles[resolvedKey] ?? plannerProfiles.deepseek;
};

export const getActorProfile = (key?: ActorProfileKey): ActorProfile => {
  const resolvedKey = key ?? DEFAULT_ACTOR_KEY;
  return actorProfiles[resolvedKey] ?? actorProfiles.qwen;
};

export const getDefaultPlannerProfileKey = (): PlannerProfileKey => {
  const key = (import.meta.env.VITE_PLANNER_PROFILE as PlannerProfileKey) ?? 'deepseek';
  return plannerProfiles[key] ? key : 'deepseek';
};

export const getDefaultActorProfileKey = (): ActorProfileKey => {
  const key = (import.meta.env.VITE_ACTOR_PROFILE as ActorProfileKey) ?? 'qwen';
  return actorProfiles[key] ? key : 'qwen';
};
