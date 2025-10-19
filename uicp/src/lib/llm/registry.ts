import { z } from 'zod';
import { EMIT_PLAN, EMIT_BATCH } from './tools';
import { OperationName } from '../uicp/schemas';

export type Capability = 'window' | 'dom' | 'component' | 'state' | 'api' | 'txn' | 'compute' | 'media';
export type Risk = 'low' | 'medium' | 'high';

export type ToolDescriptor = {
  name: string;
  kind: 'llm-function' | 'local-operation';
  capabilities: Capability[];
  risk: Risk;
  schema?: unknown;
};

export const LLM_TOOLS: ToolDescriptor[] = [
  {
    name: 'emit_plan',
    kind: 'llm-function',
    capabilities: ['window', 'dom', 'component', 'state', 'api', 'compute', 'txn'],
    risk: 'low',
    schema: EMIT_PLAN.function.parameters,
  },
  {
    name: 'emit_batch',
    kind: 'llm-function',
    capabilities: ['window', 'dom', 'component', 'state', 'api', 'compute', 'txn'],
    risk: 'low',
    schema: EMIT_BATCH.function.parameters,
  },
];

export const OPERATIONS: Record<z.infer<typeof OperationName>, ToolDescriptor> = {
  'window.create':      { name: 'window.create', kind: 'local-operation', capabilities: ['window'],    risk: 'low' },
  'window.move':        { name: 'window.move',   kind: 'local-operation', capabilities: ['window'],    risk: 'low' },
  'window.resize':      { name: 'window.resize', kind: 'local-operation', capabilities: ['window'],    risk: 'low' },
  'window.focus':       { name: 'window.focus',  kind: 'local-operation', capabilities: ['window'],    risk: 'low' },
  'window.update':      { name: 'window.update', kind: 'local-operation', capabilities: ['window'],    risk: 'low' },
  'window.close':       { name: 'window.close',  kind: 'local-operation', capabilities: ['window'],    risk: 'low' },
  'dom.set':            { name: 'dom.set',       kind: 'local-operation', capabilities: ['dom'],       risk: 'low' },
  'dom.replace':        { name: 'dom.replace',   kind: 'local-operation', capabilities: ['dom'],       risk: 'low' },
  'dom.append':         { name: 'dom.append',    kind: 'local-operation', capabilities: ['dom'],       risk: 'low' },
  'component.render':   { name: 'component.render',  kind: 'local-operation', capabilities: ['component'], risk: 'low' },
  'component.update':   { name: 'component.update',  kind: 'local-operation', capabilities: ['component'], risk: 'low' },
  'component.destroy':  { name: 'component.destroy', kind: 'local-operation', capabilities: ['component'], risk: 'low' },
  'state.set':          { name: 'state.set',     kind: 'local-operation', capabilities: ['state'],     risk: 'low' },
  'state.get':          { name: 'state.get',     kind: 'local-operation', capabilities: ['state'],     risk: 'low' },
  'state.watch':        { name: 'state.watch',   kind: 'local-operation', capabilities: ['state'],     risk: 'low' },
  'state.unwatch':      { name: 'state.unwatch', kind: 'local-operation', capabilities: ['state'],     risk: 'low' },
  'api.call':           { name: 'api.call',      kind: 'local-operation', capabilities: ['api', 'compute'], risk: 'medium' },
  'needs.code':         { name: 'needs.code',    kind: 'local-operation', capabilities: ['compute'],   risk: 'medium' },
  'txn.cancel':         { name: 'txn.cancel',    kind: 'local-operation', capabilities: ['txn'],       risk: 'low' },
} as const;

export const getToolRegistrySummary = (): string => {
  const toolLines = LLM_TOOLS.map((tool) =>
    `- ${tool.name} (kind=${tool.kind}, capabilities=${tool.capabilities.join(', ')}, risk=${tool.risk})`,
  );

  const operationLines = Object.values(OPERATIONS).map((descriptor) =>
    descriptor.name === 'api.call'
      ? `- ${descriptor.name} (capabilities=${descriptor.capabilities.join(', ')}, risk=${descriptor.risk}, schemes=https://, mailto:, uicp://intent, uicp://compute.call, tauri://fs/writeTextFile)`
      : descriptor.name === 'needs.code'
        ? `- ${descriptor.name} (capabilities=${descriptor.capabilities.join(', ')}, risk=${descriptor.risk}, purpose=request WASI applet generation; emits progress via watched state)`
      : `- ${descriptor.name} (capabilities=${descriptor.capabilities.join(', ')}, risk=${descriptor.risk})`,
  );

  return [
    'LLM tools:',
    ...toolLines,
    '',
    'Operations:',
    ...operationLines,
  ].join('\n');
};
