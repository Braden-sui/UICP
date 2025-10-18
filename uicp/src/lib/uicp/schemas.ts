// Re-export from adapters folder for backward compatibility
export type {
  SafeHtml,
  WindowId,
  ComponentId,
  StatePath,
  OperationNameT,
  OperationParamMap,
  Envelope,
  Batch,
  BatchMetadata,
  Plan,
} from './adapters/schemas';

export {
  MAX_OPS_PER_BATCH,
  MAX_HTML_PER_OP,
  MAX_TOTAL_HTML_PER_BATCH,
  OperationName,
  operationSchemas,
  envelopeSchema,
  batchSchema,
  computeBatchHash,
  validateBatch,
  planSchema,
  validatePlan,
  isBatch,
  isPlan,
  UICPValidationError,
  asWindowId,
  asStatePath,
  sanitizeHtmlStrict,
} from './adapters/schemas';
