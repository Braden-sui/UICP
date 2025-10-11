import plannerPrompt from '../../prompts/planner.txt?raw';
import actorPrompt from '../../prompts/actor.txt?raw';
import type { ChatMessage, ToolSpec } from './ollama';

export type PlannerProfileKey = 'deepseek' | 'kimi';
export type ActorProfileKey = 'qwen' | 'kimi';

export interface PlannerProfile {
  key: PlannerProfileKey;
  label: string;
  description: string;
  defaultModel?: string;
  capabilities?: { channels: string[]; supportsTools: boolean };
  formatMessages: (intent: string, opts?: { tools?: ToolSpec[] }) => ChatMessage[];
}

export interface ActorProfile {
  key: ActorProfileKey;
  label: string;
  description: string;
  defaultModel?: string;
  capabilities?: { channels: string[]; supportsTools: boolean };
  formatMessages: (planJson: string, opts?: { tools?: ToolSpec[] }) => ChatMessage[];
}

const plannerProfiles: Record<PlannerProfileKey, PlannerProfile> = {
  deepseek: {
    key: 'deepseek',
    label: 'DeepSeek V3.1',
    description: 'Legacy planner prompt tuned for DeepSeek reasoning mode.',
    defaultModel: 'deepseek-v3.1:671b',
    capabilities: { channels: ['json'], supportsTools: true },
    formatMessages: (intent) => [
      { role: 'system', content: plannerPrompt.trim() },
      { role: 'user', content: intent },
    ],
  },
  kimi: {
    key: 'kimi',
    label: 'Kimi K2',
    description: 'Planner prompt for Kimi-k2:1t.',
    defaultModel: 'kimi-k2:1t',
    capabilities: { channels: ['json'], supportsTools: true },
    formatMessages: (intent) => [
      { role: 'system', content: plannerPrompt.trim() },
      { role: 'user', content: intent },
    ],
  },
};

const actorProfiles: Record<ActorProfileKey, ActorProfile> = {
  qwen: {
    key: 'qwen',
    label: 'Qwen3-Coder 480B',
    description: 'Legacy actor prompt tuned for Qwen tool calling.',
    defaultModel: 'qwen3-coder:480b',
    capabilities: { channels: ['json'], supportsTools: true },
    formatMessages: (planJson) => [
      { role: 'system', content: actorPrompt.trim() },
      { role: 'user', content: planJson },
    ],
  },
  kimi: {
    key: 'kimi',
    label: 'Kimi K2',
    description: 'Actor prompt for Kimi-k2:1t.',
    defaultModel: 'kimi-k2:1t',
    capabilities: { channels: ['json'], supportsTools: true },
    formatMessages: (planJson) => [
      { role: 'system', content: actorPrompt.trim() },
      { role: 'user', content: planJson },
    ],
  },
};

export const listPlannerProfiles = (): PlannerProfile[] => Object.values(plannerProfiles);
export const listActorProfiles = (): ActorProfile[] => Object.values(actorProfiles);

export const getPlannerProfile = (key?: PlannerProfileKey): PlannerProfile => {
  const resolvedKey = key ?? (import.meta.env.VITE_PLANNER_PROFILE as PlannerProfileKey) ?? 'deepseek';
  return plannerProfiles[resolvedKey] ?? plannerProfiles.deepseek;
};

export const getActorProfile = (key?: ActorProfileKey): ActorProfile => {
  const resolvedKey = key ?? (import.meta.env.VITE_ACTOR_PROFILE as ActorProfileKey) ?? 'qwen';
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
