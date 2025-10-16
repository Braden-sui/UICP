import plannerPrompt from '../../prompts/planner.txt?raw';
import actorPrompt from '../../prompts/actor.txt?raw';
import type { ChatMessage, ToolSpec } from './ollama';

export type PlannerProfileKey = 'glm' | 'deepseek' | 'kimi' | 'wil' | 'qwen' | 'gpt-oss';
export type ActorProfileKey = 'glm' | 'qwen' | 'kimi' | 'gpt-oss';

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
  wil: {
    key: 'wil',
    label: 'WIL Deterministic',
    description: 'Local deterministic planner using the words→intent lexicon (no model call).',
    capabilities: { channels: ['text'], supportsTools: false },
    formatMessages: (intent) => [
      { role: 'system', content: 'WIL deterministic planner: no model messages used.' },
      { role: 'user', content: intent },
    ],
  },
  glm: {
    key: 'glm',
    label: 'GLM 4.6',
    description: 'Advanced agentic, reasoning and coding capabilities with 198K context window.',
    defaultModel: 'glm-4.6:cloud',
    capabilities: { channels: ['json'], supportsTools: true },
    formatMessages: (intent: string) => [
      { role: 'system', content: plannerPrompt.trim() },
      { role: 'user', content: intent },
    ],
  },
  'gpt-oss': {
    key: 'gpt-oss',
    label: 'GPT-OSS 120B',
    description: 'Open-source GPT model with 120B parameters.',
    defaultModel: 'gpt-oss:120b',
    capabilities: { channels: ['json'], supportsTools: false },
    formatMessages: (intent: string) => [
      { role: 'system', content: plannerPrompt.trim() },
      { role: 'user', content: intent },
    ],
  },
  deepseek: {
    key: 'deepseek',
    label: 'DeepSeek V3.1',
    description: 'Legacy planner prompt tuned for DeepSeek reasoning mode.',
    defaultModel: 'deepseek-v3.1:671b',
    capabilities: { channels: ['json'], supportsTools: false },
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
    capabilities: { channels: ['json'], supportsTools: false },
    formatMessages: (intent) => [
      { role: 'system', content: plannerPrompt.trim() },
      { role: 'user', content: intent },
    ],
  },
  qwen: {
    key: 'qwen',
    label: 'Qwen3-Coder 480B',
    description: 'Planner prompt for Qwen3-Coder (fallback when DeepSeek unavailable).',
    defaultModel: 'qwen3-coder:480b',
    capabilities: { channels: ['json'], supportsTools: false },
    formatMessages: (intent) => [
      { role: 'system', content: plannerPrompt.trim() },
      { role: 'user', content: intent },
    ],
  },
};

const actorProfiles: Record<ActorProfileKey, ActorProfile> = {
  glm: {
    key: 'glm',
    label: 'GLM 4.6',
    description: 'Advanced agentic, reasoning and coding capabilities with 198K context window.',
    defaultModel: 'glm-4.6:cloud',
    capabilities: { channels: ['json'], supportsTools: true },
    formatMessages: (planJson: string) => [
      { role: 'system', content: actorPrompt.trim() },
      { role: 'user', content: planJson },
    ],
  },
  'gpt-oss': {
    key: 'gpt-oss',
    label: 'GPT-OSS 120B',
    description: 'Open-source GPT model with 120B parameters.',
    defaultModel: 'gpt-oss:120b',
    capabilities: { channels: ['json'], supportsTools: false },
    formatMessages: (planJson: string) => [
      { role: 'system', content: actorPrompt.trim() },
      { role: 'user', content: planJson },
    ],
  },
  qwen: {
    key: 'qwen',
    label: 'Qwen3-Coder 480B',
    description: 'Legacy actor prompt tuned for Qwen tool calling.',
    defaultModel: 'qwen3-coder:480b',
    capabilities: { channels: ['json'], supportsTools: false },
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
    capabilities: { channels: ['json'], supportsTools: false },
    formatMessages: (planJson) => [
      { role: 'system', content: actorPrompt.trim() },
      { role: 'user', content: planJson },
    ],
  },
};

export const listPlannerProfiles = (): PlannerProfile[] => Object.values(plannerProfiles);
export const listActorProfiles = (): ActorProfile[] => Object.values(actorProfiles);

export const getPlannerProfile = (key?: PlannerProfileKey): PlannerProfile => {
  const resolvedKey = key ?? (import.meta.env.VITE_PLANNER_PROFILE as PlannerProfileKey) ?? 'qwen';
  return plannerProfiles[resolvedKey] ?? plannerProfiles.qwen;
};

export const getActorProfile = (key?: ActorProfileKey): ActorProfile => {
  const resolvedKey = key ?? (import.meta.env.VITE_ACTOR_PROFILE as ActorProfileKey) ?? 'qwen';
  return actorProfiles[resolvedKey] ?? actorProfiles.qwen;
};

export const getDefaultPlannerProfileKey = (): PlannerProfileKey => {
  const key = (import.meta.env.VITE_PLANNER_PROFILE as PlannerProfileKey) ?? 'qwen';
  return plannerProfiles[key] ? key : 'qwen';
};

export const getDefaultActorProfileKey = (): ActorProfileKey => {
  const key = (import.meta.env.VITE_ACTOR_PROFILE as ActorProfileKey) ?? 'qwen';
  return actorProfiles[key] ? key : 'qwen';
};
