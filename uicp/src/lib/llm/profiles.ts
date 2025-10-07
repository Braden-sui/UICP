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

const formatToolDocs = (tools?: ToolSpec[]): string => {
  if (!tools?.length) return '';
  const lines: string[] = ['# Tools'];
  tools.forEach((tool, index) => {
    if (tool && typeof tool === 'object') {
      const record = tool as Record<string, unknown>;
      if (record.type === 'function' && record.function && typeof record.function === 'object') {
        const fnRecord = record.function as Record<string, unknown>;
        const name = typeof fnRecord.name === 'string' ? fnRecord.name : `tool_${index + 1}`;
        const description = typeof fnRecord.description === 'string' ? fnRecord.description : '';
        lines.push(description ? `- ${name}: ${description}` : `- ${name}`);
        if ('parameters' in fnRecord) {
          lines.push(`  - parameters: ${JSON.stringify(fnRecord.parameters)}`);
        }
        return;
      }
    }
    lines.push(`- tool_${index + 1}: ${JSON.stringify(tool)}`);
  });
  return lines.join('\n');
};

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
    // Base model tag normalized to -cloud by the backend when targeting Ollama Cloud.
    defaultModel: 'gpt-oss:120b',
    formatMessages: (intent, opts) => {
      const harmonyRequirements = `# Harmony Output Requirements\n- Valid assistant channels: analysis, commentary, final. Every assistant message must declare exactly one channel.\n- Emit chain-of-thought in analysis (keep private), tool reasoning + function calls in commentary, and the user-facing summary in final ending with <|return|>.\n- When invoking a tool, end the commentary message with <|call|> and wait for a tool reply before continuing.`;
      const responseFormat = `# Response Formats\n## uicp_plan\n{"type":"object","required":["summary","batch"],"properties":{"summary":{"type":"string","minLength":1},"risks":{"type":"array","items":{"type":"string"}},"batch":{"type":"array","items":{"type":"object"}}}}\n## example_uicp_plan\n{"summary":"Summarize the proposed desktop change","risks":["Potential selector mismatch"],"batch":[{"op":"window.create","params":{"id":"plan_window","title":"Plan Overview","width":520,"height":360}},{"op":"dom.set","params":{"windowId":"plan_window","target":"#root","html":"<div>Plan preview</div>"}}]}`;
      const toolsDoc = formatToolDocs(opts?.tools);
      const instructionsSections = [plannerPrompt.trim(), harmonyRequirements, toolsDoc, responseFormat].filter(Boolean);
      return [
        {
          role: 'developer',
          content: instructionsSections.join('\n\n'),
        },
        { role: 'user', content: intent },
      ];
    },
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
    // Base model tag normalized to -cloud by the backend when targeting Ollama Cloud.
    defaultModel: 'gpt-oss:120b',
    formatMessages: (planJson, opts) => {
      const harmonyRequirements = `# Harmony Output Requirements\n- Preview reasoning in analysis, but keep it private.\n- Emit function/tool calls on the commentary channel with <|call|> terminators.\n- Return the final UICP batch JSON on the final channel followed by <|return|>.`;
      const responseFormat = `# Response Formats\n## uicp_batch\n{"type":"object","required":["batch"],"properties":{"batch":{"type":"array","items":{"type":"object"}}}}\n## example_uicp_batch\n{"batch":[{"op":"window.create","params":{"id":"main_window","title":"Assistant Output","width":520,"height":360}},{"op":"dom.set","params":{"windowId":"main_window","target":"#root","html":"<div>Rendered UI</div>"}}]}`;
      const toolsDoc = formatToolDocs(opts?.tools);
      const instructionsSections = [actorPrompt.trim(), harmonyRequirements, toolsDoc, responseFormat].filter(Boolean);
      return [
        {
          role: 'developer',
          content: instructionsSections.join('\n\n'),
        },
        { role: 'user', content: planJson },
      ];
    },
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
