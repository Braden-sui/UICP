 
const WindowCreateParams = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string', minLength: 1 },
    x: { type: 'number' },
    y: { type: 'number' },
    width: { type: 'number', minimum: 120 },
    height: { type: 'number', minimum: 120 },
    zIndex: { type: 'integer' },
    size: { type: 'string', enum: ['xs', 'sm', 'md', 'lg', 'xl'] },
  },
  required: ['title'],
  additionalProperties: false,
} as const;

const WindowUpdateParams = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    x: { type: 'number' },
    y: { type: 'number' },
    width: { type: 'number', minimum: 120 },
    height: { type: 'number', minimum: 120 },
    zIndex: { type: 'integer' },
  },
  required: ['id'],
  additionalProperties: false,
} as const;

const WindowCloseParams = {
  type: 'object',
  properties: { id: { type: 'string' } },
  required: ['id'],
  additionalProperties: false,
} as const;

const DomHtmlParams = {
  type: 'object',
  properties: {
    windowId: { type: 'string', minLength: 1 },
    target: { type: 'string', minLength: 1 },
    html: { type: 'string', maxLength: 65536 },
    sanitize: { type: 'boolean' },
  },
  required: ['windowId', 'target', 'html'],
  additionalProperties: false,
} as const;

const ComponentRenderParams = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    windowId: { type: 'string', minLength: 1 },
    target: { type: 'string', minLength: 1 },
    type: { type: 'string', minLength: 1 },
    props: {},
  },
  required: ['windowId', 'target', 'type'],
  additionalProperties: false,
} as const;

const ComponentUpdateParams = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    props: {},
  },
  required: ['id', 'props'],
  additionalProperties: false,
} as const;

const ComponentDestroyParams = {
  type: 'object',
  properties: { id: { type: 'string' } },
  required: ['id'],
  additionalProperties: false,
} as const;

const NeedsCodeParams = {
  type: 'object',
  properties: {
    spec: { type: 'string', minLength: 1 },
    language: { type: 'string', enum: ['ts', 'rust', 'python'], default: 'ts' },
    constraints: { type: 'object', additionalProperties: true },
    caps: { type: 'object', additionalProperties: true },
    artifactId: { type: 'string', minLength: 1 },
    goldenKey: { type: 'string', minLength: 1 },
    progressWindowId: { type: 'string', minLength: 1 },
    progressSelector: { type: 'string', minLength: 1 },
    cachePolicy: { type: 'string', enum: ['readwrite', 'readOnly', 'bypass'], default: 'readwrite' },
  },
  required: ['spec'],
  additionalProperties: false,
} as const;

const StateSetParams = {
  type: 'object',
  properties: {
    scope: { type: 'string', enum: ['window', 'workspace', 'global'] },
    key: { type: 'string' },
    value: {},
    windowId: { type: 'string', minLength: 1 },
    ttlMs: { type: 'integer', minimum: 1 },
  },
  required: ['scope', 'key', 'value'],
  additionalProperties: false,
} as const;

const StateGetParams = {
  type: 'object',
  properties: {
    scope: { type: 'string', enum: ['window', 'workspace', 'global'] },
    key: { type: 'string' },
    windowId: { type: 'string', minLength: 1 },
  },
  required: ['scope', 'key'],
  additionalProperties: false,
} as const;

const StateWatchParams = {
  type: 'object',
  properties: {
    scope: { type: 'string', enum: ['window', 'workspace', 'global'] },
    key: { type: 'string' },
    selector: { type: 'string', minLength: 1 },
    mode: { type: 'string', enum: ['replace', 'append'], default: 'replace' },
    windowId: { type: 'string', minLength: 1 },
  },
  required: ['scope', 'key', 'selector'],
  additionalProperties: false,
} as const;

const StateUnwatchParams = {
  type: 'object',
  properties: {
    scope: { type: 'string', enum: ['window', 'workspace', 'global'] },
    key: { type: 'string' },
    selector: { type: 'string', minLength: 1 },
    windowId: { type: 'string', minLength: 1 },
  },
  required: ['scope', 'key', 'selector'],
  additionalProperties: false,
} as const;

const StatePatchPath = {
  anyOf: [
    { type: 'string', minLength: 1 },
    {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
    },
  ],
} as const;

const StatePatchParams = {
  type: 'object',
  properties: {
    scope: { type: 'string', enum: ['window', 'workspace', 'global'] },
    key: { type: 'string' },
    windowId: { type: 'string', minLength: 1 },
    ops: {
      type: 'array',
      minItems: 1,
      items: {
        oneOf: [
          {
            type: 'object',
            properties: {
              op: { const: 'set' },
              value: {},
              path: StatePatchPath,
            },
            required: ['op', 'value'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              op: { const: 'merge' },
              value: { type: 'object', additionalProperties: true },
              path: StatePatchPath,
            },
            required: ['op', 'value'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              op: { const: 'toggle' },
              path: StatePatchPath,
            },
            required: ['op'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              op: { const: 'setIfNull' },
              value: {},
              path: StatePatchPath,
            },
            required: ['op', 'value'],
            additionalProperties: false,
          },
        ],
      },
    },
  },
  required: ['scope', 'key', 'ops'],
  additionalProperties: false,
} as const;

const ApiCallParams = {
  type: 'object',
  properties: {
    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET' },
    url: {
      anyOf: [
        { type: 'string', pattern: '^https?://' },
        { type: 'string', pattern: '^mailto:' },
        { type: 'string', pattern: '^uicp://intent(?:(?:/|\\?).*)?$' },
        { type: 'string', pattern: '^uicp://compute\\.call(?:(?:/|\\?).*)?$' },
        { type: 'string', pattern: '^tauri://fs/writeTextFile(?:(?:/|\\?).*)?$' },
      ],
    },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
    body: {},
    idempotencyKey: { type: 'string' },
    into: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['window', 'workspace', 'global'] },
        key: { type: 'string' },
        windowId: { type: 'string' },
        correlationId: { type: 'string' },
      },
      required: ['scope', 'key'],
      additionalProperties: false,
    },
  },
  required: ['method', 'url'],
  additionalProperties: false,
} as const;

const TxnCancelParams = {
  type: 'object',
  properties: { id: { type: 'string' } },
  additionalProperties: false,
} as const;

 
const envelopeOneOf = [
  { type: 'object', properties: { id: { type: 'string' }, idempotencyKey: { type: 'string' }, traceId: { type: 'string' }, txnId: { type: 'string' }, windowId: { type: 'string' }, op: { const: 'window.create' }, params: { $ref: '#/definitions/WindowCreateParams' } }, required: ['op', 'params'], additionalProperties: false },
  { type: 'object', properties: { id: { type: 'string' }, idempotencyKey: { type: 'string' }, traceId: { type: 'string' }, txnId: { type: 'string' }, windowId: { type: 'string' }, op: { const: 'window.update' }, params: { $ref: '#/definitions/WindowUpdateParams' } }, required: ['op', 'params'], additionalProperties: false },
  { type: 'object', properties: { id: { type: 'string' }, idempotencyKey: { type: 'string' }, traceId: { type: 'string' }, txnId: { type: 'string' }, windowId: { type: 'string' }, op: { const: 'window.close' }, params: { $ref: '#/definitions/WindowCloseParams' } }, required: ['op', 'params'], additionalProperties: false },
  { type: 'object', properties: { id: { type: 'string' }, idempotencyKey: { type: 'string' }, traceId: { type: 'string' }, txnId: { type: 'string' }, windowId: { type: 'string' }, op: { const: 'dom.set' }, params: { $ref: '#/definitions/DomHtmlParams' } }, required: ['op', 'params'], additionalProperties: false },
  { type: 'object', properties: { id: { type: 'string' }, idempotencyKey: { type: 'string' }, traceId: { type: 'string' }, txnId: { type: 'string' }, windowId: { type: 'string' }, op: { const: 'dom.replace' }, params: { $ref: '#/definitions/DomHtmlParams' } }, required: ['op', 'params'], additionalProperties: false },
  { type: 'object', properties: { id: { type: 'string' }, idempotencyKey: { type: 'string' }, traceId: { type: 'string' }, txnId: { type: 'string' }, windowId: { type: 'string' }, op: { const: 'dom.append' }, params: { $ref: '#/definitions/DomHtmlParams' } }, required: ['op', 'params'], additionalProperties: false },
  { type: 'object', properties: { id: { type: 'string' }, idempotencyKey: { type: 'string' }, traceId: { type: 'string' }, txnId: { type: 'string' }, windowId: { type: 'string' }, op: { const: 'component.render' }, params: { $ref: '#/definitions/ComponentRenderParams' } }, required: ['op', 'params'], additionalProperties: false },
  { type: 'object', properties: { id: { type: 'string' }, idempotencyKey: { type: 'string' }, traceId: { type: 'string' }, txnId: { type: 'string' }, windowId: { type: 'string' }, op: { const: 'component.update' }, params: { $ref: '#/definitions/ComponentUpdateParams' } }, required: ['op', 'params'], additionalProperties: false },
  { type: 'object', properties: { id: { type: 'string' }, idempotencyKey: { type: 'string' }, traceId: { type: 'string' }, txnId: { type: 'string' }, windowId: { type: 'string' }, op: { const: 'component.destroy' }, params: { $ref: '#/definitions/ComponentDestroyParams' } }, required: ['op', 'params'], additionalProperties: false },
  { type: 'object', properties: { id: { type: 'string' }, idempotencyKey: { type: 'string' }, traceId: { type: 'string' }, txnId: { type: 'string' }, windowId: { type: 'string' }, op: { const: 'needs.code' }, params: { $ref: '#/definitions/NeedsCodeParams' } }, required: ['op', 'params'], additionalProperties: false },
  { type: 'object', properties: { id: { type: 'string' }, idempotencyKey: { type: 'string' }, traceId: { type: 'string' }, txnId: { type: 'string' }, windowId: { type: 'string' }, op: { const: 'state.set' }, params: { $ref: '#/definitions/StateSetParams' } }, required: ['op', 'params'], additionalProperties: false },
  { type: 'object', properties: { id: { type: 'string' }, idempotencyKey: { type: 'string' }, traceId: { type: 'string' }, txnId: { type: 'string' }, windowId: { type: 'string' }, op: { const: 'state.get' }, params: { $ref: '#/definitions/StateGetParams' } }, required: ['op', 'params'], additionalProperties: false },
  { type: 'object', properties: { id: { type: 'string' }, idempotencyKey: { type: 'string' }, traceId: { type: 'string' }, txnId: { type: 'string' }, windowId: { type: 'string' }, op: { const: 'state.watch' }, params: { $ref: '#/definitions/StateWatchParams' } }, required: ['op', 'params'], additionalProperties: false },
  { type: 'object', properties: { id: { type: 'string' }, idempotencyKey: { type: 'string' }, traceId: { type: 'string' }, txnId: { type: 'string' }, windowId: { type: 'string' }, op: { const: 'state.unwatch' }, params: { $ref: '#/definitions/StateUnwatchParams' } }, required: ['op', 'params'], additionalProperties: false },
  { type: 'object', properties: { id: { type: 'string' }, idempotencyKey: { type: 'string' }, traceId: { type: 'string' }, txnId: { type: 'string' }, windowId: { type: 'string' }, op: { const: 'state.patch' }, params: { $ref: '#/definitions/StatePatchParams' } }, required: ['op', 'params'], additionalProperties: false },
  { type: 'object', properties: { id: { type: 'string' }, idempotencyKey: { type: 'string' }, traceId: { type: 'string' }, txnId: { type: 'string' }, windowId: { type: 'string' }, op: { const: 'api.call' }, params: { $ref: '#/definitions/ApiCallParams' } }, required: ['op', 'params'], additionalProperties: false },
  { type: 'object', properties: { id: { type: 'string' }, idempotencyKey: { type: 'string' }, traceId: { type: 'string' }, txnId: { type: 'string' }, windowId: { type: 'string' }, op: { const: 'txn.cancel' }, params: { $ref: '#/definitions/TxnCancelParams' } }, required: ['op', 'params'], additionalProperties: false },
] as const;

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
    
    WindowCreateParams,
    WindowUpdateParams,
    WindowCloseParams,
    DomHtmlParams,
    ComponentRenderParams,
    ComponentUpdateParams,
    ComponentDestroyParams,
    NeedsCodeParams,
    StateSetParams,
    StateGetParams,
    StateWatchParams,
    StateUnwatchParams,
    StatePatchParams,
    ApiCallParams,
    TxnCancelParams,
    
    Envelope: { oneOf: envelopeOneOf },
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
    // Param definitions
    WindowCreateParams,
    WindowUpdateParams,
    WindowCloseParams,
    DomHtmlParams,
    ComponentRenderParams,
    ComponentUpdateParams,
    ComponentDestroyParams,
    NeedsCodeParams,
    StateSetParams,
    StateGetParams,
    StateWatchParams,
    StateUnwatchParams,
    StatePatchParams,
    ApiCallParams,
    TxnCancelParams,
    // Discriminated Envelope union
    Envelope: { oneOf: envelopeOneOf },
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
