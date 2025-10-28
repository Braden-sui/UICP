import plannerPrompt from '../../prompts/planner.txt?raw';
import taskSpecPrompt from '../../prompts/planner_task_spec.txt?raw';
import actorPrompt from '../../prompts/actor.txt?raw';
import type { ChatMessage, ToolSpec } from './llm.stream';

export type ReasoningEffort = 'low' | 'medium' | 'high';

export type PlannerProfileKey = 'glm' | 'deepseek' | 'kimi' | 'wil' | 'qwen' | 'gpt-oss';
export type ActorProfileKey = 'glm' | 'qwen' | 'kimi' | 'gpt-oss' | 'deepseek';

export interface PlannerProfile {
  key: PlannerProfileKey;
  label: string;
  description: string;
  defaultModel?: string;
  capabilities?: { channels: string[]; supportsTools: boolean };
  formatMessages: (
    intent: string,
    opts?: { tools?: ToolSpec[]; taskSpec?: unknown; toolSummary?: string },
  ) => ChatMessage[];
  formatTaskSpecMessages?: (intent: string, opts: { toolSummary: string }) => ChatMessage[];
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
    formatMessages: (intent: string, opts) => [
      { role: 'system', content: plannerPrompt.trim() },
      {
        role: 'user',
        content: [
          `User intent:\n${intent}`,
          opts?.taskSpec ? `TaskSpec JSON:\n${JSON.stringify(opts.taskSpec, null, 2)}` : undefined,
          opts?.toolSummary ? `Available tools:\n${opts.toolSummary}` : undefined,
        ]
          .filter((segment): segment is string => Boolean(segment))
          .join('\n\n'),
      },
    ],
    formatTaskSpecMessages: (intent, { toolSummary }) => [
      {
        role: 'system',
        content: taskSpecPrompt
          .replace('{{USER_TEXT}}', intent)
          .replace('{{TOOL_REGISTRY_SUMMARY}}', toolSummary)
          .trim(),
      },
    ],
  },
  'gpt-oss': {
    key: 'gpt-oss',
    label: 'GPT-OSS 120B',
      description: 'Advanced opensource model by OpenAI',
    defaultModel: 'gpt-oss:120b',
    capabilities: { channels: ['json'], supportsTools: true },
    formatMessages: (intent: string, opts) => [
      { role: 'system', content: plannerPrompt.trim() },
      {
        role: 'user',
        content: [
          `User intent:\n${intent}`,
          opts?.taskSpec ? `TaskSpec JSON:\n${JSON.stringify(opts.taskSpec, null, 2)}` : undefined,
          opts?.toolSummary ? `Available tools:\n${opts.toolSummary}` : undefined,
        ]
          .filter((segment): segment is string => Boolean(segment))
          .join('\n\n'),
      },
    ],
    formatTaskSpecMessages: (intent, { toolSummary }) => [
      {
        role: 'system',
        content: taskSpecPrompt
          .replace('{{USER_TEXT}}', intent)
          .replace('{{TOOL_REGISTRY_SUMMARY}}', toolSummary)
          .trim(),
      },
    ],
  },
  deepseek: {
    key: 'deepseek',
    label: 'DeepSeek V3.1',
    description: 'Planner profile tuned for DeepSeek V3.1.',
    defaultModel: 'deepseek-v3.1:671b',
    capabilities: { channels: ['json'], supportsTools: true },
    formatMessages: (intent, opts) => [
      { role: 'system', content: plannerPrompt.trim() },
      {
        role: 'user',
        content: [
          `User intent:\n${intent}`,
          opts?.taskSpec ? `TaskSpec JSON:\n${JSON.stringify(opts.taskSpec, null, 2)}` : undefined,
          opts?.toolSummary ? `Available tools:\n${opts.toolSummary}` : undefined,
        ]
          .filter((segment): segment is string => Boolean(segment))
          .join('\n\n'),
      },
    ],
    formatTaskSpecMessages: (intent, { toolSummary }) => [
      {
        role: 'system',
        content: taskSpecPrompt
          .replace('{{USER_TEXT}}', intent)
          .replace('{{TOOL_REGISTRY_SUMMARY}}', toolSummary)
          .trim(),
      },
    ],
  },
  kimi: {
    key: 'kimi',
    label: 'Kimi K2',
    description: 'Planner profile for Kimi-k2:1t.',
    defaultModel: 'kimi-k2:1t',
    capabilities: { channels: ['json'], supportsTools: true },
    formatMessages: (intent, opts) => [
      { role: 'system', content: plannerPrompt.trim() },
      {
        role: 'user',
        content: [
          `User intent:\n${intent}`,
          opts?.taskSpec ? `TaskSpec JSON:\n${JSON.stringify(opts.taskSpec, null, 2)}` : undefined,
          opts?.toolSummary ? `Available tools:\n${opts.toolSummary}` : undefined,
        ]
          .filter((segment): segment is string => Boolean(segment))
          .join('\n\n'),
      },
    ],
    formatTaskSpecMessages: (intent, { toolSummary }) => [
      {
        role: 'system',
        content: taskSpecPrompt
          .replace('{{USER_TEXT}}', intent)
          .replace('{{TOOL_REGISTRY_SUMMARY}}', toolSummary)
          .trim(),
      },
    ],
  },
  qwen: {
    key: 'qwen',
    label: 'Qwen3-Coder 480B',
    description: 'Planner profile for Qwen3-Coder:480B by Alibaba.',
    defaultModel: 'qwen3-coder:480b',
    capabilities: { channels: ['json'], supportsTools: true },
    formatMessages: (intent, opts) => [
      { role: 'system', content: plannerPrompt.trim() },
      {
        role: 'user',
        content: [
          `User intent:\n${intent}`,
          opts?.taskSpec ? `TaskSpec JSON:\n${JSON.stringify(opts.taskSpec, null, 2)}` : undefined,
          opts?.toolSummary ? `Available tools:\n${opts.toolSummary}` : undefined,
        ]
          .filter((segment): segment is string => Boolean(segment))
          .join('\n\n'),
      },
    ],
    formatTaskSpecMessages: (intent, { toolSummary }) => [
      {
        role: 'system',
        content: taskSpecPrompt
          .replace('{{USER_TEXT}}', intent)
          .replace('{{TOOL_REGISTRY_SUMMARY}}', toolSummary)
          .trim(),
      },
    ],
  },
};

const actorProfiles: Record<ActorProfileKey, ActorProfile> = {
  glm: {
    key: 'glm',
    label: 'GLM 4.6',
    description: 'Advanced agentic reasoning and coding capabilities.',
    capabilities: { channels: ['json'], supportsTools: true },
    formatMessages: (planJson: string) => [
      { role: 'system', content: actorPrompt.trim() },
      { role: 'user', content: planJson },
    ],
  },
  'gpt-oss': {
    key: 'gpt-oss',
    label: 'GPT-OSS 120B',
    description: 'Open-source GPT model with advanced reasoning capabilities.',
    capabilities: { channels: ['json'], supportsTools: true },
    formatMessages: (planJson: string) => [
      { role: 'system', content: actorPrompt.trim() },
      { role: 'user', content: planJson },
    ],
  },
  qwen: {
    key: 'qwen',
    label: 'Qwen3-Coder 480B',
    description: 'Coding and reasoning-focused execution profile.',
    capabilities: { channels: ['json'], supportsTools: true },
    formatMessages: (planJson) => [
      { role: 'system', content: actorPrompt.trim() },
      { role: 'user', content: planJson },
    ],
  },
  kimi: {
    key: 'kimi',
    label: 'Kimi K2',
    description: 'Multilingual reasoning and execution profile.',
    capabilities: { channels: ['json'], supportsTools: true },
    formatMessages: (planJson) => [
      { role: 'system', content: actorPrompt.trim() },
      { role: 'user', content: planJson },
    ],
  },
  deepseek: {
    key: 'deepseek',
    label: 'DeepSeek V3.1',
    description: 'High-performance reasoning and execution profile.',
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

export const listPlannerProfiles = (): PlannerProfile[] =>
  Object.values(plannerProfiles).filter((profile) => profile.key !== 'wil');
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
