import plannerPrompt from '../../prompts/planner.txt?raw';
import actorPrompt from '../../prompts/actor.txt?raw';
import type { ChatMessage, ToolSpec } from './ollama';

export type PlannerProfileKey = 'glm' | 'deepseek' | 'kimi' | 'wil' | 'qwen' | 'gpt-oss';
export type ActorProfileKey = 'glm' | 'qwen' | 'kimi' | 'gpt-oss' | 'deepseek';

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
    capabilities: { channels: ['json'], supportsTools: true },
    formatMessages: (intent: string) => [
      { role: 'system', content: plannerPrompt.trim() },
      { role: 'user', content: intent },
    ],
  },
  deepseek: {
    key: 'deepseek',
    label: 'DeepSeek V3.1',
    description: 'Planner profile tuned for DeepSeek V3.1 (optional alt).',
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
    description: 'Planner profile for Kimi-k2:1t (optional alt).',
    defaultModel: 'kimi-k2:1t',
    capabilities: { channels: ['json'], supportsTools: true },
    formatMessages: (intent) => [
      { role: 'system', content: plannerPrompt.trim() },
      { role: 'user', content: intent },
    ],
  },
  qwen: {
    key: 'qwen',
    label: 'Qwen3-Coder 480B',
    description: 'Planner prompt for Qwen3-Coder).',
    defaultModel: 'qwen3-coder:480b',
    capabilities: { channels: ['json'], supportsTools: true },
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
    capabilities: { channels: ['json'], supportsTools: true },
    formatMessages: (planJson: string) => [
      { role: 'system', content: actorPrompt.trim() },
      { role: 'user', content: planJson },
    ],
  },
  qwen: {
    key: 'qwen',
    label: 'Qwen3-Coder 480B',
    description: 'Actor profile tuned for Qwen tool calling (optional alt).',
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
    description: 'Actor profile for Kimi-k2:1t (optional alt).',
    defaultModel: 'kimi-k2:1t',
    capabilities: { channels: ['json'], supportsTools: true },
    formatMessages: (planJson) => [
      { role: 'system', content: actorPrompt.trim() },
      { role: 'user', content: planJson },
    ],
  },
  deepseek: {
    key: 'deepseek',
    label: 'DeepSeek V3.1',
    description: 'Actor profile tuned for DeepSeek tool calling.',
    defaultModel: 'deepseek-v3.1:671b',
    capabilities: { channels: ['json'], supportsTools: true },
    formatMessages: (planJson: string) => [
      { role: 'system', content: actorPrompt.trim() },
      { role: 'user', content: planJson },
    ],
  },
};

const resolvePlannerEnvKey = (key: PlannerProfileKey | undefined): PlannerProfileKey =>
  (key && plannerProfiles[key] ? key : 'glm');

const resolveActorEnvKey = (key: ActorProfileKey | undefined): ActorProfileKey =>
  (key && actorProfiles[key] ? key : 'glm');

let selectedPlannerProfileKey: PlannerProfileKey = resolvePlannerEnvKey(
  import.meta.env.VITE_PLANNER_PROFILE as PlannerProfileKey | undefined,
);

let selectedActorProfileKey: ActorProfileKey = resolveActorEnvKey(
  import.meta.env.VITE_ACTOR_PROFILE as ActorProfileKey | undefined,
);

export const setSelectedPlannerProfileKey = (key: PlannerProfileKey): void => {
  if (plannerProfiles[key]) {
    selectedPlannerProfileKey = key;
  }
};

export const setSelectedActorProfileKey = (key: ActorProfileKey): void => {
  if (actorProfiles[key]) {
    selectedActorProfileKey = key;
  }
};

export const getSelectedPlannerProfileKey = (): PlannerProfileKey => selectedPlannerProfileKey;
export const getSelectedActorProfileKey = (): ActorProfileKey => selectedActorProfileKey;

export const listPlannerProfiles = (): PlannerProfile[] => Object.values(plannerProfiles);
export const listActorProfiles = (): ActorProfile[] => Object.values(actorProfiles);

export const getPlannerProfile = (key?: PlannerProfileKey): PlannerProfile => {
  const resolvedKey = key ?? selectedPlannerProfileKey;
  return plannerProfiles[resolvedKey] ?? plannerProfiles[selectedPlannerProfileKey];
};

export const getActorProfile = (key?: ActorProfileKey): ActorProfile => {
  const resolvedKey = key ?? selectedActorProfileKey;
  return actorProfiles[resolvedKey] ?? actorProfiles[selectedActorProfileKey];
};

export const getDefaultPlannerProfileKey = (): PlannerProfileKey => selectedPlannerProfileKey;
export const getDefaultActorProfileKey = (): ActorProfileKey => selectedActorProfileKey;
