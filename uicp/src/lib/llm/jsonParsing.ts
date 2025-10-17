import { validatePlan, validateBatch, type Plan, type Batch } from '../uicp/schemas';

export type ToolName = 'emit_plan' | 'emit_batch';

type ParsedTool = { name: ToolName; args: unknown };

const TOOL_NAMES: ToolName[] = ['emit_plan', 'emit_batch'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';

const addJsonSegments = (target: Set<string>, input: string): Set<string> => {
  const trimmed = input.trim();
  if (!trimmed) return target;
  target.add(trimmed);

  if (trimmed.startsWith('```')) {
    const fenceBody = trimmed.replace(/^```[^\n]*\n?/, '').replace(/```$/, '').trim();
    if (fenceBody) target.add(fenceBody);
  }

  const addBalanced = (extractor: (chunk: string) => string | null, start: string) => {
    const idx = trimmed.indexOf(start);
    if (idx !== -1) {
      const slice = trimmed.slice(idx);
      const result = extractor(slice);
      if (result) target.add(result);
    }
  };

  addBalanced(extractBalancedJsonObject, '{');
  addBalanced(extractBalancedJsonArray, '[');

  return target;
};

export function parseToolFromText(text: string, expectedName: ToolName): ParsedTool | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const candidateStrings = addJsonSegments(new Set<string>(), trimmed);

  const lower = trimmed.toLowerCase();
  for (const name of TOOL_NAMES) {
    let index = lower.indexOf(name);
    while (index !== -1) {
      const after = trimmed.slice(index + name.length);
      addJsonSegments(candidateStrings, after);
      index = lower.indexOf(name, index + 1);
    }
  }

  for (const segment of candidateStrings) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(segment);
    } catch {
      continue;
    }
    const resolved = resolveToolPayload(parsed, expectedName);
    if (resolved) return resolved;
  }

  return null;
}

export function normalizePlanJson(value: unknown): Plan {
  const visited = new Set<unknown>();
  const queue: unknown[] = [value];
  let lastError: unknown;

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === null || current === undefined) continue;

    if (typeof current === 'string') {
      const segments = addJsonSegments(new Set<string>(), current);
      for (const segment of segments) {
        try {
          queue.push(JSON.parse(segment));
        } catch {
          continue;
        }
      }
      continue;
    }

    if (Array.isArray(current)) {
      if (visited.has(current)) continue;
      visited.add(current);
      for (const entry of current) queue.push(entry);
      continue;
    }

    if (!isRecord(current) || visited.has(current)) continue;
    visited.add(current);

    const candidate = coercePlanRecord(current);
    if (candidate) {
      try {
        return validatePlan(candidate);
      } catch (err) {
        lastError = err;
      }
    }

    for (const nested of collectNestedValues(current)) {
      queue.push(nested);
    }
  }

  const msg =
    lastError instanceof Error ? lastError.message : typeof lastError === 'string' ? lastError : 'no valid plan payload';
  throw new Error(`E-UICP-0420: Failed to normalize plan JSON payload (${msg})`);
}

export function normalizeBatchJson(value: unknown): Batch {
  const visited = new Set<unknown>();
  const queue: unknown[] = [value];
  let lastError: unknown;

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === null || current === undefined) continue;

    if (typeof current === 'string') {
      const segments = addJsonSegments(new Set<string>(), current);
      for (const segment of segments) {
        try {
          queue.push(JSON.parse(segment));
        } catch {
          continue;
        }
      }
      continue;
    }

    if (Array.isArray(current)) {
      if (visited.has(current)) continue;
      visited.add(current);
      const batch = tryValidateBatch(current);
      if (batch) return batch;
      for (const entry of current) queue.push(entry);
      continue;
    }

    if (!isRecord(current) || visited.has(current)) continue;
    visited.add(current);

    const batch = tryValidateBatchFromRecord(current);
    if (batch) return batch;

    for (const nested of collectNestedValues(current)) {
      queue.push(nested);
    }

    lastError = lastError ?? 'no valid batch payload';
  }

  const msg =
    lastError instanceof Error ? lastError.message : typeof lastError === 'string' ? lastError : 'unknown batch error';
  throw new Error(`E-UICP-0421: Failed to normalize batch JSON payload (${msg})`);
}

function resolveToolPayload(value: unknown, expectedName: ToolName): ParsedTool | null {
  const visited = new Set<unknown>();
  const queue: unknown[] = [value];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === null || current === undefined) continue;

    if (typeof current === 'string') {
      const segments = addJsonSegments(new Set<string>(), current);
      for (const segment of segments) {
        try {
          queue.push(JSON.parse(segment));
        } catch {
          continue;
        }
      }
      continue;
    }

    if (Array.isArray(current)) {
      if (visited.has(current)) continue;
      visited.add(current);
      if (expectedName === 'emit_batch') {
        return { name: 'emit_batch', args: current };
      }
      for (const entry of current) queue.push(entry);
      continue;
    }

    if (!isRecord(current) || visited.has(current)) continue;
    visited.add(current);

    const rawName = detectToolName(current);
    const normalizedName = rawName ? normalizeToolName(rawName) : null;
    if (normalizedName && normalizedName === expectedName) {
      const payload = pickPayload(current, normalizedName);
      if (payload !== undefined) {
        return { name: normalizedName, args: payload };
      }
      if (normalizedName === 'emit_plan' && looksLikePlanRecord(current)) {
        return { name: normalizedName, args: current };
      }
      if (normalizedName === 'emit_batch' && looksLikeBatchRecord(current)) {
        return { name: normalizedName, args: current };
      }
    }

    if (expectedName === 'emit_plan' && looksLikePlanRecord(current)) {
      return { name: 'emit_plan', args: current };
    }
    if (expectedName === 'emit_batch' && looksLikeBatchRecord(current)) {
      return { name: 'emit_batch', args: current.batch ?? current };
    }

    for (const nested of collectNestedValues(current)) {
      queue.push(nested);
    }
  }

  return null;
}

function tryValidateBatch(entries: unknown[]): Batch | null {
  const normalized: unknown[] = [];
  try {
    for (const entry of entries) {
      normalized.push(normalizeEnvelope(entry));
    }
    return validateBatch(normalized);
  } catch {
    return null;
  }
}

function tryValidateBatchFromRecord(record: Record<string, unknown>): Batch | null {
  if (Array.isArray(record.batch)) {
    return tryValidateBatch(record.batch);
  }
  if (typeof record.batch === 'string') {
    try {
      const parsed = JSON.parse(record.batch);
      if (Array.isArray(parsed)) {
        return tryValidateBatch(parsed);
      }
    } catch {
      return null;
    }
  }
  const arr = coerceBatchArray(record);
  return arr ? tryValidateBatch(arr) : null;
}

function looksLikePlanRecord(record: Record<string, unknown>): boolean {
  if (typeof record.summary !== 'string' || record.summary.trim().length === 0) return false;
  const batch = record.batch ?? record.plan_batch ?? record.actions ?? record.steps;
  if (batch === undefined) return true;
  if (Array.isArray(batch)) return true;
  if (typeof batch === 'string') {
    try {
      const parsed = JSON.parse(batch);
      return Array.isArray(parsed);
    } catch {
      return false;
    }
  }
  return isRecord(batch);
}

function looksLikeBatchRecord(record: Record<string, unknown>): record is Record<string, unknown> & { batch?: unknown } {
  if (Array.isArray(record.batch)) return true;
  if (typeof record.batch === 'string') return record.batch.trim().startsWith('[');
  return false;
}

function detectToolName(value: Record<string, unknown>): string | null {
  if (typeof value.name === 'string') return value.name;
  if (typeof value.type === 'string') return value.type;
  const fn = value.function;
  if (isRecord(fn) && typeof fn.name === 'string') return fn.name;
  return null;
}

function normalizeToolName(name: string): ToolName | null {
  const lower = name.toLowerCase();
  if (lower.includes('emit_plan')) return 'emit_plan';
  if (lower.includes('emit_batch')) return 'emit_batch';
  return null;
}

function pickPayload(value: Record<string, unknown>, name: ToolName): unknown | undefined {
  if (value.arguments !== undefined) return value.arguments;
  if (value.args !== undefined) return value.args;
  const fn = value.function;
  if (isRecord(fn)) {
    if (fn.arguments !== undefined) return fn.arguments;
    if (fn.args !== undefined) return fn.args;
  }
  if (name === 'emit_plan' && looksLikePlanRecord(value)) {
    return value;
  }
  if (name === 'emit_batch' && looksLikeBatchRecord(value)) {
    return value.batch ?? value;
  }
  return undefined;
}

function collectNestedValues(record: Record<string, unknown>): unknown[] {
  const out: unknown[] = [];
  for (const value of Object.values(record)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') {
      out.push(value);
      continue;
    }
    if (Array.isArray(value)) {
      out.push(value);
      for (const entry of value) out.push(entry);
      continue;
    }
    if (isRecord(value)) {
      out.push(value);
    }
  }
  return out;
}

function coercePlanRecord(input: Record<string, unknown>): Record<string, unknown> | null {
  const summary = extractSummary(input);
  if (!summary) return null;

  const risks = pickFirst(input, ['risks', 'risk', 'risk_list', 'issues']);
  const actorHintsRaw = pickFirst(input, ['actor_hints', 'actorHints', 'actor-hints', 'hints']);
  const batchSource = pickFirst(input, ['batch', 'plan_batch', 'actions', 'steps']);

  let batch: Batch;
  if (batchSource !== undefined) {
    batch = normalizeBatchJson(batchSource);
  } else {
    batch = [];
  }

  const normalized: Record<string, unknown> = {
    summary: summary.trim(),
    batch,
  };

  if (risks !== undefined) normalized.risks = risks;
  const actorHints = coerceActorHints(actorHintsRaw);
  if (actorHints && actorHints.length > 0) {
    normalized.actor_hints = actorHints;
  }

  return normalized;
}

function extractSummary(record: Record<string, unknown>): string | null {
  const candidate = pickFirst(record, ['summary', 'plan_summary', 'title', 'outline']);
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate;
  }
  return null;
}

function coerceActorHints(value: unknown): string[] | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    const hints = value.filter((hint): hint is string => typeof hint === 'string').map((hint) => hint.trim());
    return hints.length > 0 ? hints : null;
  }
  if (typeof value === 'string') {
    const hints = value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return hints.length > 0 ? hints : null;
  }
  return null;
}

function pickFirst(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return record[key];
    }
  }
  return undefined;
}

function normalizeEnvelope(entry: unknown): unknown {
  if (!entry || typeof entry !== 'object') return entry;
  const e = { ...(entry as Record<string, unknown>) };
  if (!('op' in e) && typeof e.method === 'string') {
    e.op = e.method;
    delete e.method;
  }
  renameKey(e, 'idempotency_key', 'idempotencyKey');
  renameKey(e, 'trace_id', 'traceId');
  renameKey(e, 'txn_id', 'txnId');
  renameKey(e, 'window_id', 'windowId');

  if (typeof e.op === 'string' && Object.prototype.hasOwnProperty.call(e, 'params')) {
    e.params = normalizeParams(e.op, e.params);
  }

  return e;
}

function renameKey(record: Record<string, unknown>, from: string, to: string) {
  if (!Object.prototype.hasOwnProperty.call(record, from)) return;
  if (!Object.prototype.hasOwnProperty.call(record, to)) {
    record[to] = record[from]!;
  }
  delete record[from];
}

function normalizeParams(op: string, params: unknown): unknown {
  if (!params || typeof params !== 'object') return params;
  const record = { ...(params as Record<string, unknown>) };
  const renameParam = (from: string, to: string) => {
    if (!Object.prototype.hasOwnProperty.call(record, from)) return;
    if (!Object.prototype.hasOwnProperty.call(record, to)) {
      record[to] = record[from]!;
    }
    delete record[from];
  };

  switch (op) {
    case 'window.create':
    case 'window.update':
      renameParam('z_index', 'zIndex');
      renameParam('window_id', 'windowId');
      break;
    case 'dom.set':
    case 'dom.replace':
    case 'dom.append':
    case 'component.render':
    case 'component.update':
    case 'component.destroy':
      renameParam('window_id', 'windowId');
      break;
    case 'state.set':
    case 'state.get':
    case 'state.watch':
    case 'state.unwatch':
      renameParam('window_id', 'windowId');
      break;
    case 'api.call':
    case 'txn.cancel':
      renameParam('idempotency_key', 'idempotencyKey');
      break;
    default:
      break;
  }

  return record;
}

function coerceBatchArray(value: Record<string, unknown>): unknown[] | null {
  const candidates = [
    value.batch,
    value.data,
    value.result,
    value.args,
    value.arguments,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (typeof candidate === 'string') {
      try {
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        continue;
      }
    }
    if (isRecord(candidate) && Array.isArray(candidate.batch)) {
      return candidate.batch;
    }
  }

  return null;
}

function extractBalancedJsonObject(input: string): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        return input.slice(start, i + 1);
      }
    }
  }
  return null;
}

function extractBalancedJsonArray(input: string): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '[') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === ']') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        return input.slice(start, i + 1);
      }
    }
  }
  return null;
}
