/**
 * Adapter Error Codes and Classes
 * 
 * Strict error taxonomy for adapter v2 operations.
 * All errors must use one of these codes for consistent handling.
 */

export type AdapterErrorCode =
  | 'Adapter.InvalidEnvelope'
  | 'Adapter.ValidationFailed'
  | 'Adapter.PermissionDenied'
  | 'Adapter.WindowNotFound'
  | 'Adapter.DomApplyFailed'
  | 'Adapter.ComponentUnknown'
  | 'Adapter.Internal';

/**
 * Structured error class for adapter operations.
 * Includes error code, message, and optional context for debugging.
 */
export class AdapterError extends Error {
  public readonly code: AdapterErrorCode;
  public readonly context?: Record<string, unknown>;

  constructor(
    code: AdapterErrorCode,
    message: string,
    context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.context = context;
  }

  /**
   * Serialize to plain object for logging/telemetry
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
    };
  }
}

/**
 * Error report structure for ApplyOutcome.
 * Tracks which operation failed and why.
 */
export interface AdapterErrorReport {
  opIndex: number;
  code: AdapterErrorCode;
  message: string;
}

/**
 * Factory function to create error reports from exceptions.
 * Normalizes Error objects and unknown values into consistent format.
 */
export const createErrorReport = (
  opIndex: number,
  code: AdapterErrorCode,
  error: unknown
): AdapterErrorReport => ({
  opIndex,
  code,
  message: error instanceof Error ? error.message : String(error),
});

/**
 * Type guard to check if value is an AdapterError
 */
export const isAdapterError = (error: unknown): error is AdapterError => {
  return error instanceof AdapterError;
};

/**
 * Extract error code from unknown error, defaulting to Internal
 */
export const getErrorCode = (error: unknown): AdapterErrorCode => {
  if (isAdapterError(error)) {
    return error.code;
  }
  return 'Adapter.Internal';
};
