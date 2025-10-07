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

type JsonRecord = Record<string, unknown>;

type JsonSchema = JsonRecord & {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  items?: JsonSchema | JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  default?: unknown;
};

const HARMONY_KNOWLEDGE_CUTOFF = '2024-06';

const isoDate = (): string => {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = `${now.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${now.getUTCDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const buildHarmonySystemMessage = (hasTools: boolean): ChatMessage => {
  const lines = [
    'You are ChatGPT, a large language model trained by OpenAI.',
    `Knowledge cutoff: ${HARMONY_KNOWLEDGE_CUTOFF}`,
    `Current date: ${isoDate()}`,
    '',
    'Reasoning: high',
    '',
    '# Valid channels: analysis, commentary, final. Channel must be included for every message.',
  ];
  if (hasTools) {
    lines.push("Calls to these tools must go to the commentary channel: 'functions'.");
  }
  return {
    role: 'system',
    content: lines.join('\n'),
  };
};

const normalizePrompt = (input: string): string => {
  return input
    .replace(/\r\n/g, '\n')
    .trim()
    .replace(/^System:\s*/i, '')
    .trim();
};

const joinSections = (sections: string[]): string =>
  sections.filter((section) => section.trim().length > 0).join('\n\n');

const stringifyLiteral = (value: unknown): string => {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (value === undefined) {
    return 'undefined';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const renderInlineType = (schema: JsonSchema | undefined): string => {
  if (!schema || typeof schema !== 'object') return 'any';

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map((item) => stringifyLiteral(item)).join(' | ');
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
    return stringifyLiteral(schema.const);
  }

  const composite = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(composite) && composite.length > 0) {
    return composite.map((entry) => renderInlineType(entry)).join(' | ');
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.map((entry) => renderInlineType(entry)).join(' & ');
  }

  const { type } = schema;
  if (Array.isArray(type) && type.length > 0) {
    return type.map((t) => renderInlineType({ ...schema, type: t })).join(' | ');
  }

  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const items = schema.items;
      if (Array.isArray(items)) {
        return `[${items.map((entry) => renderInlineType(entry)).join(', ')}]`;
      }
      const itemType = renderInlineType(items as JsonSchema | undefined);
      return `${itemType}[]`;
    }
    case 'object': {
      const properties = schema.properties && typeof schema.properties === 'object' ? (schema.properties as Record<string, JsonSchema>) : {};
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      const entries = Object.entries(properties).map(([key, value]) => {
        const optional = !required.has(key);
        return `${key}${optional ? '?' : ''}: ${renderInlineType(value)}`;
      });
      let additional: string | undefined;
      if (typeof schema.additionalProperties === 'object') {
        additional = `[key: string]: ${renderInlineType(schema.additionalProperties as JsonSchema)}`;
      } else if (schema.additionalProperties === true) {
        additional = '[key: string]: unknown';
      }
      if (additional) entries.push(additional);
      if (!entries.length) {
        return '{ [key: string]: unknown }';
      }
      return `{ ${entries.join(', ')} }`;
    }
    default:
      return typeof type === 'string' && type.length > 0 ? type : 'any';
  }
};

const renderObjectSchema = (schema: JsonSchema, indent = 0): string => {
  const pad = (level: number) => '  '.repeat(level);
  const properties = schema.properties && typeof schema.properties === 'object' ? (schema.properties as Record<string, JsonSchema>) : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const lines: string[] = ['{'];
  for (const [key, value] of Object.entries(properties)) {
    const description = typeof value.description === 'string' ? value.description.trim() : '';
    if (description) {
      for (const descLine of description.split(/\r?\n/)) {
        lines.push(`${pad(indent + 1)}// ${descLine.trim()}`);
      }
    }
    if (value.default !== undefined) {
      lines.push(`${pad(indent + 1)}// default: ${stringifyLiteral(value.default)}`);
    }
    const optional = !required.has(key);
    lines.push(`${pad(indent + 1)}${key}${optional ? '?' : ''}: ${renderInlineType(value)},`);
  }

  if (schema.additionalProperties) {
    const additional =
      typeof schema.additionalProperties === 'object'
        ? renderInlineType(schema.additionalProperties as JsonSchema)
        : 'unknown';
    lines.push(`${pad(indent + 1)}[key: string]: ${additional},`);
  }

  lines.push(`${pad(indent)}}`);
  return lines.join('\n');
};

const renderSchema = (schema: JsonSchema | undefined, indent = 0): string => {
  if (!schema || typeof schema !== 'object') return 'any';
  const { type } = schema;
  if ((type === 'object' || schema.properties) && typeof schema.properties === 'object') {
    return renderObjectSchema(schema, indent);
  }
  if (type === 'array' && !schema.items) {
    return 'unknown[]';
  }
  return renderInlineType(schema);
};

const formatFunctionTool = (tool: ToolSpec, index: number): string => {
  if (!tool || typeof tool !== 'object') {
    return `  type tool_${index + 1} = (_: Record<string, unknown>) => any;`;
  }
  const record = tool as JsonRecord;
  if (record.type !== 'function' || typeof record.function !== 'object') {
    return `  type tool_${index + 1} = (_: Record<string, unknown>) => any;`;
  }
  const fn = record.function as JsonRecord;
  const rawName = typeof fn.name === 'string' && fn.name.trim().length > 0 ? fn.name.trim() : `tool_${index + 1}`;
  const name = rawName.replace(/[^a-zA-Z0-9_]/g, '_');
  const description = typeof fn.description === 'string' ? fn.description.trim() : '';
  const parameters = renderSchema(fn.parameters as JsonSchema | undefined, 2);
  const lines: string[] = [];
  if (description) {
    for (const line of description.split(/\r?\n/)) {
      lines.push(`  // ${line.trim()}`);
    }
  }
  if (parameters.startsWith('{')) {
    const indented = parameters
      .split('\n')
      .map((line, idx) => (idx === 0 ? line : `    ${line}`))
      .join('\n');
    lines.push(`  type ${name} = (_: ${indented}) => any;`);
  } else {
    lines.push(`  type ${name} = (_: ${parameters}) => any;`);
  }
  return lines.join('\n');
};

const formatToolDocs = (tools?: ToolSpec[]): string => {
  if (!tools?.length) return '';
  const body = tools.map((tool, index) => formatFunctionTool(tool, index)).join('\n\n');
  return ['# Tools', '', '## functions', '', 'namespace functions {', body, '} // namespace functions'].join('\n');
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
    defaultModel: 'gpt-oss:120b',
    formatMessages: (intent, opts) => {
      const harmonyRequirements = [
        '# Harmony Output Requirements',
        '- Use the analysis channel for private chain-of-thought reasoning. Do not expose analysis content to the user.',
        '- Emit function calls on the commentary channel, terminate the request with <|call|>, and wait for tool output before continuing.',
        '- Return the final JSON on the final channel and end the message with <|return|>.',
        '- Do not wrap JSON in Markdown code fences or add prose outside the JSON object.',
      ].join('\n');
      const responseFormat = [
        '# Structured Output Format',
        '- Respond with a single JSON object and nothing else.',
        '- JSON Schema:',
        '{"type":"object","required":["summary","batch"],"properties":{"summary":{"type":"string","minLength":1},"risks":{"type":"array","items":{"type":"string"}},"batch":{"type":"array","items":{"type":"object"}}}}',
        '- Keep HTML compact (single line) and safe (no <script>, <style>, on* handlers, or javascript: URLs).',
      ].join('\n');
      const toolsDoc = formatToolDocs(opts?.tools);
      const structuredClarifier = [
        '# Structured Clarifier Flow',
        '- When essential details are missing, set summary to the natural-language question and ensure it ends with a question mark.',
        '- Include the risk token \"clarifier:structured\" and omit other clarifier:* tokens.',
        '- Emit a single batch entry: {\\\"op\\\":\\\"api.call\\\",\\\"params\\\":{\\\"method\\\":\\\"POST\\\",\\\"url\\\":\\\"uicp://intent\\\",\\\"body\\\":{...}}}.',
        '- Populate body with title, textPrompt, submit label, and a fields array describing each input (use name, label, placeholder, and type). Default to one text field named \"answer\" when unsure.',
        '- Do not emit window.*, dom.*, component.*, or state.* commands when producing a structured clarifier.',
        '- After presenting the clarifier, expect the runtime to re-run planning with the merged answer. Subsequent plans must omit clarifier:structured.',
      ].join('\
');
      const developerSections = [
        `# Instructions\n${normalizePrompt(plannerPrompt)}`,
        harmonyRequirements,
        toolsDoc,
        responseFormat,
        structuredClarifier,
        '# Failure Handling\n- Ask clarifying questions if essential details are missing.\n- If a safe implementation is impossible, explain why and return an empty batch.',
      ];
      return [
        buildHarmonySystemMessage(Boolean(opts?.tools?.length)),
        {
          role: 'developer',
          content: joinSections(developerSections),
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
    defaultModel: 'gpt-oss:120b',
    formatMessages: (planJson, opts) => {
      const harmonyRequirements = [
        '# Harmony Output Requirements',
        '- Use the analysis channel for reasoning about the plan and evaluating tool output.',
        '- Perform tool invocations on the commentary channel with <|call|> and resume once the tool replies.',
        '- Emit the final batch JSON on the final channel with <|return|> and no surrounding prose.',
        '- Never return Markdown fences or extra narration.',
      ].join('\n');
      const responseFormat = [
        '# Structured Output Format',
        '- Respond with JSON. Preferred form: {"batch":[Command...]}.',
        '- Commands must comply with the UICP operation schema (window.*, dom.*, component.*, state.*, api.call, txn.cancel).',
        '- Ensure accessibility hints and stable window IDs follow the plan guidance.',
      ].join('\n');
      const toolsDoc = formatToolDocs(opts?.tools);
      const developerSections = [
        `# Instructions\n${normalizePrompt(actorPrompt)}`,
        harmonyRequirements,
        toolsDoc,
        responseFormat,
        '# Safety\n- Abort with an error window if the plan cannot be completed safely.',
      ];
      return [
        buildHarmonySystemMessage(Boolean(opts?.tools?.length)),
        {
          role: 'developer',
          content: joinSections(developerSections),
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
