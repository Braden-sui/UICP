import { OperationName } from '../uicp/schemas';

const envelopeDefinition = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['command'] },
    id: { type: 'string' },
    idempotencyKey: { type: 'string' },
    traceId: { type: 'string' },
    txnId: { type: 'string' },
    windowId: { type: 'string' },
    op: { type: 'string', enum: OperationName.options },
    params: { type: 'object' },
  },
  required: ['op'],
  additionalProperties: false,
} as const;

export const planSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    risks: {
      anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 10 }],
    },
    actor_hints: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 20,
    },
    batch: {
      type: 'array',
      items: { $ref: '#/definitions/Envelope' },
    },
  },
  required: ['summary', 'batch'],
  additionalProperties: false,
  definitions: {
    Envelope: envelopeDefinition,
  },
} as const;

export const batchSchema = {
  type: 'object',
  properties: {
    batch: {
      type: 'array',
      items: { $ref: '#/definitions/Envelope' },
    },
  },
  required: ['batch'],
  additionalProperties: false,
  definitions: {
    Envelope: envelopeDefinition,
  },
} as const;

export const EMIT_PLAN = {
  type: 'function',
  function: {
    name: 'emit_plan',
    description: 'Return the UICP planning result',
    parameters: planSchema,
  },
} as const;

export const EMIT_BATCH = {
  type: 'function',
  function: {
    name: 'emit_batch',
    description: 'Return a batch of UICP envelopes to execute',
    parameters: batchSchema,
  },
} as const;

export type EmitPlanTool = typeof EMIT_PLAN;
export type EmitBatchTool = typeof EMIT_BATCH;
