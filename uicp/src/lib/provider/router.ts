export type ProviderHint = 'local' | 'llm' | 'wasm';

export type CapabilitySet = {
  fsRead?: string[];
  fsWrite?: string[];
  net?: string[];
  env?: string[];
  time?: boolean;
  random?: boolean;
};

export type ResourceLimits = {
  memLimitMb?: number;
  timeoutMs?: number;
  fuel?: number;
};

export type ProviderDecision =
  | { kind: 'local' }
  | { kind: 'llm'; model: string }
  | {
      kind: 'wasm';
      moduleId: string;
      capabilities: CapabilitySet;
      limits: ResourceLimits;
      inputs: string[];
      cacheMode: 'readwrite' | 'readonly' | 'bypass';
      workspaceId: string;
      policyVersion: string;
    };

export type PolicyDecideParams = {
  operation: string;
  params?: Record<string, unknown>;
  hint?: ProviderHint;
  workspaceId?: string;
};

const POLICY_VERSION = '2025-10-22';

function extractInputs(params?: Record<string, unknown>): string[] {
  const inputs: string[] = [];
  if (!params) return inputs;
  const scan = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('ws:/')) inputs.push(v);
    } else if (Array.isArray(v)) {
      for (const item of v) scan(item);
    } else if (v && typeof v === 'object') {
      for (const value of Object.values(v as Record<string, unknown>)) scan(value);
    }
  };
  scan(params);
  return Array.from(new Set(inputs));
}

export function policyDecide({ operation, params, hint, workspaceId }: PolicyDecideParams): ProviderDecision {
  const op = (operation || '').trim().toLowerCase();
  const ws = workspaceId && workspaceId.trim().length ? workspaceId : 'default';
  const inputs = extractInputs(params);

  const deterministicOps = new Set<string>(['patch.summarize', 'patch.normalize', 'metrics.aggregate']);

  if (deterministicOps.has(op) || hint === 'wasm') {
    const moduleId = op === 'metrics.aggregate' ? 'uicp/metrics-agg@1' : 'uicp/patch-tools@1';
    const limits: ResourceLimits = {
      memLimitMb: op === 'metrics.aggregate' ? 256 : 128,
      timeoutMs: op === 'metrics.aggregate' ? 8000 : 5000,
    };
    const capabilities: CapabilitySet = {
      fsRead: inputs.filter((p) => p.startsWith('ws:/')),
      time: false,
      random: false,
    };
    const cacheMode: 'readwrite' | 'readonly' | 'bypass' = 'readwrite';
    return {
      kind: 'wasm',
      moduleId,
      capabilities,
      limits,
      inputs,
      cacheMode,
      workspaceId: ws,
      policyVersion: POLICY_VERSION,
    };
  }

  if (hint === 'llm') {
    return { kind: 'llm', model: '' };
  }

  return { kind: 'local' };
}
