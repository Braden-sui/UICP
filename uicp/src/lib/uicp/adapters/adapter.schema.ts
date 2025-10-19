/**
 * Adapter Schema Validation
 * 
 * Zod schemas for adapter v2 operations.
 * All incoming envelopes must pass validation before reaching modules.
 */

import { z } from 'zod';
import type { Envelope } from './adapter.types';
import { AdapterError } from './adapter.errors';

/**
 * Base envelope schema
 * Validates structure before operation-specific validation
 */
export const EnvelopeSchema = z.object({
  id: z.string().min(1, 'Envelope ID required').optional(),
  op: z.string().min(1, 'Operation name required'),
  params: z.unknown(),
  timestamp: z.number().optional(),
  idempotencyKey: z.string().optional(),
  traceId: z.string().optional(),
  txnId: z.string().optional(),
  windowId: z.string().optional(),
});

/**
 * Window creation parameters
 */
export const CreateWindowParamsSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1, 'Window title required'),
  size: z.enum(['sm', 'md', 'lg', 'xl', 'full']).optional(),
  width: z.number().min(200).max(4000).optional(),
  height: z.number().min(150).max(3000).optional(),
  position: z.object({
    x: z.number(),
    y: z.number(),
  }).optional(),
  zIndex: z.number().optional(),
});

/**
 * Window move parameters
 */
export const MoveWindowParamsSchema = z.object({
  id: z.string().min(1, 'Window ID required'),
  x: z.number(),
  y: z.number(),
});

/**
 * Window resize parameters
 */
export const ResizeWindowParamsSchema = z.object({
  id: z.string().min(1, 'Window ID required'),
  width: z.number().min(200).max(4000),
  height: z.number().min(150).max(3000),
});

/**
 * Window focus parameters
 */
export const FocusWindowParamsSchema = z.object({
  id: z.string().min(1, 'Window ID required'),
});

/**
 * Window close parameters
 */
export const CloseWindowParamsSchema = z.object({
  id: z.string().min(1, 'Window ID required'),
});

/**
 * DOM apply parameters
 */
export const DomApplyParamsSchema = z.object({
  windowId: z.string().min(1, 'Window ID required'),
  target: z.string().min(1, 'DOM target selector required'),
  html: z.string(),
  sanitize: z.boolean().optional().default(true),
  mode: z.enum(['set', 'replace', 'append']).optional().default('set'),
});

/**
 * Component render parameters
 */
export const ComponentRenderParamsSchema = z.object({
  windowId: z.string().min(1, 'Window ID required'),
  id: z.string().optional(),
  type: z.string().min(1, 'Component type required'),
  target: z.string().min(1, 'DOM target selector required'),
  props: z.record(z.unknown()).optional(),
});

/**
 * Operation-specific parameter schemas by operation name
 */
export const OperationParamsSchemas: Record<string, z.ZodType> = {
  'window.create': CreateWindowParamsSchema,
  'window.move': MoveWindowParamsSchema,
  'window.resize': ResizeWindowParamsSchema,
  'window.focus': FocusWindowParamsSchema,
  'window.close': CloseWindowParamsSchema,
  'dom.set': DomApplyParamsSchema,
  'dom.replace': DomApplyParamsSchema,
  'dom.append': DomApplyParamsSchema,
  'component.render': ComponentRenderParamsSchema,
};

/**
 * Validate envelope structure and shape.
 * Throws AdapterError on validation failure.
 */
export const validateEnvelope = (input: unknown): Envelope => {
  const baseResult = EnvelopeSchema.safeParse(input);
  
  if (!baseResult.success) {
    const errors = baseResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new AdapterError(
      'Adapter.InvalidEnvelope',
      `Envelope validation failed: ${errors}`,
      { errors: baseResult.error.errors }
    );
  }
  
  return baseResult.data as Envelope;
};

/**
 * Validate operation-specific parameters.
 * Throws AdapterError if params don't match operation schema.
 */
export const validateOperationParams = <T = unknown>(
  operation: string,
  params: unknown
): T => {
  const schema = OperationParamsSchemas[operation];
  
  if (!schema) {
    // Unknown operation - pass params through
    // Module will handle or reject
    return params as T;
  }
  
  const result = schema.safeParse(params);
  
  if (!result.success) {
    const errors = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new AdapterError(
      'Adapter.ValidationFailed',
      `Operation ${operation} parameter validation failed: ${errors}`,
      { operation, errors: result.error.errors }
    );
  }
  
  return result.data as T;
};

/**
 * Type guard to check if value matches envelope shape
 */
export const isValidEnvelopeShape = (input: unknown): input is Envelope => {
  try {
    validateEnvelope(input);
    return true;
  } catch {
    return false;
  }
};

/**
 * Strict validation that throws on any deviation.
 * Used at adapter entry point to enforce contract.
 */
export const strictValidateEnvelope = (input: unknown): Envelope => {
  // First validate base structure
  const envelope = validateEnvelope(input);
  
  // Then validate operation-specific params
  validateOperationParams(envelope.op, envelope.params);
  
  return envelope;
};
