import { z } from 'zod';

// Type brands for stronger invariants at compile time
type Brand<T, B extends string> = T & { readonly __brand?: B };
export type SafeHtml = Brand<string, 'SafeHtml'>;
export type WindowId = Brand<string, 'WindowId'>;
export type ComponentId = Brand<string, 'ComponentId'>;
export type StatePath = Brand<string, 'StatePath'>;

// Budgets and limits
export const MAX_OPS_PER_BATCH = 64;
export const MAX_HTML_PER_OP = 64 * 1024; // 64KB
export const MAX_TOTAL_HTML_PER_BATCH = 128 * 1024; // 128KB

// Brand constructors (guarded rollout)
export function asWindowId(value: string): WindowId {
  const v = String(value ?? '').trim();
  if (!v) throw new Error('window id empty');
  return v as WindowId;
}

export function asStatePath(value: string): StatePath {
  const v = String(value ?? '').trim();
  if (!v) throw new Error('state path empty');
  if (v.length > 256) throw new Error('state path too long');
  return v as StatePath;
}

// Centralised schema map so planner results and streamed events (via Tauri) are validated consistently before touching the DOM.
export const OperationName = z.enum([
  'window.create',
  'window.move',
  'window.resize',
  'window.focus',
  'window.update',
  'window.close',
  'dom.set',
  'dom.replace',
  'dom.append',
  'component.render',
  'component.update',
  'component.destroy',
  'state.set',
  'state.get',
  'state.watch',
  'state.unwatch',
  'api.call',
  'txn.cancel',
]);

export type OperationNameT = z.infer<typeof OperationName>;

type DomHtmlOp = 'dom.set' | 'dom.replace' | 'dom.append';

function isDomHtmlOperation(env: Envelope): env is Envelope<DomHtmlOp> {
  return env.op === 'dom.set' || env.op === 'dom.replace' || env.op === 'dom.append';
}

const WindowCreateParams = z.object({
  id: z.string().optional(),
  title: z.string().min(1),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().min(120).optional(),
  height: z.number().min(120).optional(),
  zIndex: z.number().int().optional(),
  size: z.enum(['xs', 'sm', 'md', 'lg', 'xl']).optional(),
}).strict();

const WindowMoveParams = z
  .object({
    id: z.string(),
    x: z.number(),
    y: z.number(),
  })
  .strict();

const WindowResizeParams = z
  .object({
    id: z.string(),
    width: z.number().min(120),
    height: z.number().min(120),
  })
  .strict();

const WindowFocusParams = z.object({ id: z.string() }).strict();

const WindowUpdateParams = z.object({
  id: z.string(),
  title: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().min(120).optional(),
  height: z.number().min(120).optional(),
  zIndex: z.number().int().optional(),
}).strict();

const WindowCloseParams = z.object({ id: z.string() }).strict();

const DomSetParams = z
  .object({
    windowId: z.string().min(1),
    target: z.string().min(1),
    html: z.string().max(MAX_HTML_PER_OP, 'html too large (max 64KB)'),
    sanitize: z.boolean().optional(),
    mode: z.enum(['set', 'replace', 'append']).optional(),
  })
  .strict();

const DomReplaceParams = z
  .object({
    windowId: z.string().min(1),
    target: z.string().min(1),
    html: z.string().max(MAX_HTML_PER_OP, 'html too large (max 64KB)'),
    sanitize: z.boolean().optional(),
    mode: z.enum(['set', 'replace', 'append']).optional(),
  })
  .strict();

const DomAppendParams = DomReplaceParams;

const ComponentRenderParams = z.object({
  id: z.string().optional(),
  windowId: z.string().min(1),
  target: z.string().min(1),
  type: z.string().min(1),
  props: z.unknown().optional(),
}).strict();

const ComponentUpdateParams = z.object({
  id: z.string(),
  props: z.unknown(),
}).strict();

const ComponentDestroyParams = z.object({ id: z.string() }).strict();

const scopeEnum = z.enum(['window', 'workspace', 'global']);

const StateSetParams = z.object({
  scope: scopeEnum,
  key: z.string(),
  value: z.unknown(),
  windowId: z.string().min(1).optional(),
  ttlMs: z.number().int().positive().optional(),
}).strict();

const StateGetParams = z.object({
  scope: scopeEnum,
  key: z.string(),
  windowId: z.string().min(1).optional(),
}).strict();

const StateWatchParams = StateGetParams.extend({
  selector: z.string().min(1),
  mode: z.enum(['replace', 'append']).default('replace'),
}).strict();
const StateUnwatchParams = StateWatchParams.omit({ mode: true }).strict();

const ApiCallUrl = z
  .string()
  .refine(
    (value) => {
      if (value.startsWith('http://') || value.startsWith('https://')) return true;
      if (value.startsWith('mailto:')) return true;
      if (value.startsWith('uicp://intent')) return true;
      if (value.startsWith('uicp://compute.call')) return true;
      if (value.startsWith('tauri://fs/writeTextFile')) return true;
      return false;
    },
    { message: 'Unsupported api.call URL scheme' },
  );

const ApiCallIntoParams = z
  .object({
    scope: scopeEnum,
    key: z.string(),
    windowId: z.string().min(1).optional(),
    correlationId: z.string().optional(),
  })
  .strict();

const ApiCallParams = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  url: ApiCallUrl,
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  idempotencyKey: z.string().optional(),
  into: ApiCallIntoParams.optional(),
}).strict();

const TxnCancelParams = z.object({ id: z.string().optional() }).strict();

export const operationSchemas = {
  'window.create': WindowCreateParams,
  'window.move': WindowMoveParams,
  'window.resize': WindowResizeParams,
  'window.focus': WindowFocusParams,
  'window.update': WindowUpdateParams,
  'window.close': WindowCloseParams,
  'dom.set': DomSetParams,
  'dom.replace': DomReplaceParams,
  'dom.append': DomAppendParams,
  'component.render': ComponentRenderParams,
  'component.update': ComponentUpdateParams,
  'component.destroy': ComponentDestroyParams,
  'state.set': StateSetParams,
  'state.get': StateGetParams,
  'state.watch': StateWatchParams,
  'state.unwatch': StateUnwatchParams,
  'api.call': ApiCallParams,
  'txn.cancel': TxnCancelParams,
} satisfies Record<OperationNameT, z.ZodTypeAny>;

const EnvelopeBase = z.object({
  id: z.string().optional(),
  idempotencyKey: z.string().optional(),
  traceId: z.string().optional(),
  txnId: z.string().optional(),
  windowId: z.string().min(1).optional(),
  op: OperationName,
  params: z.unknown().optional(),
});

export type OperationParamMap = {
  'window.create': z.infer<typeof WindowCreateParams>;
  'window.move': z.infer<typeof WindowMoveParams>;
  'window.resize': z.infer<typeof WindowResizeParams>;
  'window.focus': z.infer<typeof WindowFocusParams>;
  'window.update': z.infer<typeof WindowUpdateParams>;
  'window.close': z.infer<typeof WindowCloseParams>;
  'dom.set': z.infer<typeof DomSetParams>;
  'dom.replace': z.infer<typeof DomReplaceParams>;
  'dom.append': z.infer<typeof DomAppendParams>;
  'component.render': z.infer<typeof ComponentRenderParams>;
  'component.update': z.infer<typeof ComponentUpdateParams>;
  'component.destroy': z.infer<typeof ComponentDestroyParams>;
  'state.set': z.infer<typeof StateSetParams>;
  'state.get': z.infer<typeof StateGetParams>;
  'state.watch': z.infer<typeof StateWatchParams>;
  'state.unwatch': z.infer<typeof StateUnwatchParams>;
  'api.call': z.infer<typeof ApiCallParams>;
  'txn.cancel': z.infer<typeof TxnCancelParams>;
};

type EnvelopeBaseFields = {
  id?: string;
  idempotencyKey?: string;
  traceId?: string;
  txnId?: string;
  windowId?: string;
};

type EnvelopeRecord = {
  [K in OperationNameT]: EnvelopeBaseFields & {
    op: K;
    params: OperationParamMap[K];
  };
};

export type Envelope<T extends OperationNameT = OperationNameT> = EnvelopeRecord[T];

export class UICPValidationError extends Error {
  pointer: string;
  issues: z.ZodIssue[];

  constructor(message: string, pointer: string, issues: z.ZodIssue[]) {
    super(message);
    this.pointer = pointer;
    this.issues = issues;
  }
}

export const envelopeSchema = EnvelopeBase.superRefine((value, ctx) => {
  const schema = operationSchemas[value.op];
  const params = value.params ?? {};
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        code: 'custom',
        path: [...ctx.path, 'params', ...issue.path],
        message: issue.message,
      });
    }
    return;
  }

  // Guardrail: reject unsafe HTML at validation time.
  if (value.op === 'dom.set' || value.op === 'dom.replace' || value.op === 'dom.append') {
    const html = (parsed.data as { html?: unknown }).html;
    if (typeof html === 'string') {
      const dangerPatterns = [
        /<script[\s>]/i,
        /<style[\s>]/i,
        /\son\w+\s*=/i, // onclick, onload, etc.
        /javascript:/i,
        /<iframe[\s>]/i,
        /<embed[\s>]/i,
        /<object[\s>]/i,
        /<form[\s>]/i,
      ];

      for (const pattern of dangerPatterns) {
        if (pattern.test(html)) {
          ctx.addIssue({
            code: 'custom',
            path: [...ctx.path, 'params', 'html'],
            message:
              'HTML contains disallowed content (script/style/on* or javascript:). Provide safe HTML only.',
          });
          return;
        }
      }
    }
  }
});

export const batchSchema = z
  .array(
    envelopeSchema.transform((value) => {
      const schema = operationSchemas[value.op];
      const parseResult = schema.safeParse(value.params ?? {});
      if (!parseResult.success) {
        throw new UICPValidationError(
          `Invalid params for ${value.op}`,
          '/params',
          parseResult.error.issues,
        );
      }

      return {
        id: value.id,
        idempotencyKey: value.idempotencyKey,
        traceId: value.traceId,
        txnId: value.txnId,
        windowId: value.windowId ?? (parseResult.data as { windowId?: string }).windowId,
        op: value.op,
        params: parseResult.data,
      } as Envelope;
    }),
  )
  .max(MAX_OPS_PER_BATCH, 'batch too large (max 64 operations)')
  .superRefine((batch, ctx) => {
    try {
      let totalHtml = 0;
      for (const env of batch) {
        if (isDomHtmlOperation(env)) {
          const h = env.params.html;
          if (typeof h === 'string') totalHtml += h.length;
        }
      }
      if (totalHtml > MAX_TOTAL_HTML_PER_BATCH) {
        ctx.addIssue({
          code: 'custom',
          message: 'total HTML too large (max 128KB per batch)',
          path: [...ctx.path, 'batch'],
        });
      }
    } catch {
      // best-effort; do not throw from refine
    }
  });

export type Batch = z.infer<typeof batchSchema>;

// Batch metadata for idempotency tracking
export type BatchMetadata = {
  batchId: string;
  opsHash: string;
  timestamp: number;
};

// Deterministic hash computation for batch operations
export function computeBatchHash(batch: Batch): string {
  // Stable stringify: sort object keys, preserve array order
  const stableStringify = (input: unknown): string => {
    const seen = new WeakSet<object>();
    const walk = (value: unknown): unknown => {
      if (value === null) return null;
      const t = typeof value;
      if (t === 'undefined' || t === 'function' || t === 'symbol') return null;
      if (t !== 'object') return value;
      const obj = value as Record<string, unknown>;
      if (seen.has(obj)) return null;
      seen.add(obj);
      if (Array.isArray(obj)) {
        return obj.map((v) => walk(v));
      }
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(obj).sort()) {
        out[key] = walk(obj[key]);
      }
      return out;
    };
    return JSON.stringify(walk(input));
  };

  // Extract operation signatures (op + params) for hashing
  const ops = batch.map((env) => ({
    op: env.op,
    params: env.params,
    windowId: env.windowId,
  }));

  const serialized = stableStringify(ops);

  // Simple hash function for batch identity (FNV-1a)
  let hash = 2166136261;
  for (let i = 0; i < serialized.length; i++) {
    hash ^= serialized.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(36);
}

export function validateBatch(input: unknown, pointer = '/'): Batch {
  try {
    return batchSchema.parse(input);
  } catch (err) {
    if (err instanceof UICPValidationError) {
      const suffix = err.pointer.startsWith('/') ? err.pointer : `/${err.pointer}`;
      throw new UICPValidationError(err.message, `${pointer}${suffix}`, err.issues);
    }
    if (err instanceof z.ZodError) {
      const [firstIssue] = err.issues;
      const suffix = firstIssue
        ? firstIssue.path.map((piece) => `/${String(piece)}`).join('')
        : '';
      throw new UICPValidationError(err.message, `${pointer}${suffix}`, err.issues);
    }
    throw err;
  }
}

// Plan validation -----------------------------------------------------------

// The planner may emit either camelCase envelopes or snake_case entries like:
// { type: "command", op, params, idempotency_key?, txn_id?, window_id? }
// We accept both and normalise to the internal Envelope/Batch shape.

const PlanEntryCamel = z
  .object({
    type: z.literal('command').optional(),
    id: z.string().optional(),
    idempotencyKey: z.string().optional(),
    traceId: z.string().optional(),
    txnId: z.string().optional(),
    windowId: z.string().min(1).optional(),
    op: OperationName,
    params: z.unknown().optional(),
  })
  .strict();

const PlanEntrySnake = z
  .object({
    type: z.literal('command').optional(),
    txn_id: z.string().optional(),
    idempotency_key: z.string().optional(),
    trace_id: z.string().optional(),
    window_id: z.string().min(1).optional(),
    op: OperationName,
    params: z.unknown().optional(),
  })
  .strict()
  .transform((v) => ({
    type: v.type,
    // Do not map txn_id to Envelope.id as the Envelope id expects a UUID.
    idempotencyKey: v.idempotency_key,
    traceId: v.trace_id,
    txnId: v.txn_id,
    windowId: v.window_id,
    op: v.op,
    params: v.params,
  }));

const planEntryNormalized = z.union([PlanEntryCamel, PlanEntrySnake]);

const actorHintsSchema = z
  .array(z.string().min(1))
  .max(20, 'actor_hints should stay concise (max 20 items)')
  .optional();

export const planSchema = z
  .object({
    summary: z.string().min(1, 'summary is required'),
    risks: z
      .union([z.string().min(1), z.array(z.string().min(1))])
      .optional(),
    batch: z.array(planEntryNormalized),
    actor_hints: actorHintsSchema,
  })
  .strict()
  .transform((v) => {
    // Normalise risks to string[] for a stable surface
    const risks = Array.isArray(v.risks) ? v.risks : v.risks ? [v.risks] : undefined;
    const actorHints = v.actor_hints?.map((hint) => hint.trim()).filter((hint) => hint.length > 0);
    // Reuse batchSchema to validate and coerce entries into typed envelopes
    const parsedBatch = validateBatch(v.batch, '/batch');
    return {
      summary: v.summary,
      risks,
      batch: parsedBatch,
      actorHints: actorHints && actorHints.length > 0 ? actorHints : undefined,
    };
  });

export type Plan = z.infer<typeof planSchema>;

export function validatePlan(input: unknown, pointer = '/'): Plan {
  const result = planSchema.safeParse(input);
  if (!result.success) {
    const [firstIssue] = result.error.issues;
    const suffix = firstIssue
      ? firstIssue.path.map((piece) => `/${String(piece)}`).join('')
      : '';
    throw new UICPValidationError(result.error.message, `${pointer}${suffix}`, result.error.issues);
  }
  return result.data;
}

// Lightweight type guards for callers that only need a boolean check
export const isBatch = (input: unknown): input is Batch => batchSchema.safeParse(input).success;
export const isPlan = (input: unknown): input is Plan => planSchema.safeParse(input).success;

