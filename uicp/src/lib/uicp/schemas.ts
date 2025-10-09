import { z } from 'zod';
import { sanitizeHtml } from '../utils';

// Centralised schema map so planner results and streamed events (via Tauri) are validated consistently before touching the DOM.
export const OperationName = z.enum([
  'window.create',
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

const DomSetParams = z.object({
  windowId: z.string().min(1),
  target: z.string().min(1),
  html: z.string().max(64 * 1024, 'html too large (max 64KB)'),
  sanitize: z.boolean().optional(),
}).strict();

const DomReplaceParams = z.object({
  windowId: z.string().min(1),
  target: z.string().min(1),
  html: z.string().max(64 * 1024, 'html too large (max 64KB)'),
  sanitize: z.boolean().optional(),
}).strict();

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

const StateWatchParams = StateGetParams;
const StateUnwatchParams = StateGetParams;

const ApiCallParams = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  idempotencyKey: z.string().optional(),
}).strict();

const TxnCancelParams = z.object({ id: z.string().optional() }).strict();

export const operationSchemas = {
  'window.create': WindowCreateParams,
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

export type OperationNameT = z.infer<typeof OperationName>;

export type Envelope<T extends OperationNameT = OperationNameT> = {
  id?: string;
  idempotencyKey?: string;
  traceId?: string;
  txnId?: string;
  windowId?: string;
  op: T;
  params: OperationParamMap[T];
};

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
      const cleaned = sanitizeHtml(html);
      if (cleaned !== html) {
        ctx.addIssue({
          code: 'custom',
          path: [...ctx.path, 'params', 'html'],
          message: 'HTML contains disallowed content (script/style/on* or javascript:). Provide safe HTML only.',
        });
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
  .max(64, 'batch too large (max 64 operations)')
  .superRefine((batch, ctx) => {
    try {
      let totalHtml = 0;
      for (const env of batch) {
        if (env.op === 'dom.set' || env.op === 'dom.replace' || env.op === 'dom.append') {
          const h = (env.params as any)?.html;
          if (typeof h === 'string') totalHtml += h.length;
        }
      }
      if (totalHtml > 128 * 1024) {
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








