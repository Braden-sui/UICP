import { sanitizeHtmlStrict as sanitizeHtmlStrictImpl } from '../../sanitizer';
// Re-export frozen schema package for backward compatibility within the uicp lib.
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
} from '../../schema';

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
} from '../../schema';
// Maintain back-compat for callers importing helpers from ./schemas
export { asWindowId, asStatePath } from '../../schema';
export const sanitizeHtmlStrict = sanitizeHtmlStrictImpl;

// Adapter-level types (moved here to break circular dependency between adapter.queue and adapter.lifecycle)
export type ApplyOptions = {
  runId?: string;
  allowPartial?: boolean;
  batchId?: string;
  opsHash?: string;
};

export type ApplyOutcome = {
  success: boolean;
  applied: number;
  skippedDuplicates: number; // Renamed from skippedDupes for consistency
  deniedByPolicy: number;
  errors: string[];
  batchId: string;
  opsHash?: string;
};
