// WHY: Universal Result<T, E> type for Tauri invoke calls with standardized E-UICP-xxx error codes.
// INVARIANT: All Tauri bridge calls should return Result<T, UICPError> for consistent error handling.

export type Result<T, E = UICPError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export class UICPError extends Error {
  readonly code: string;
  readonly detail?: string;
  readonly cause?: unknown;

  constructor(code: string, message: string, detail?: string, cause?: unknown) {
    super(message);
    this.name = 'UICPError';
    this.code = code;
    this.detail = detail;
    this.cause = cause;
  }

  // WHY: Format error for display with code prefix
  toString(): string {
    const parts = [this.code, this.message];
    if (this.detail) parts.push(this.detail);
    return parts.join(': ');
  }
}

// Standardized UICP error codes (E-UICP-####)
export const UICPErrorCode = {
  // Bridge/Tauri errors (E-UICP-01xx)
  BridgeUnavailable: 'E-UICP-0100',
  InvokeFailed: 'E-UICP-0101',
  EventListenerFailed: 'E-UICP-0102',
  
  // Sanitization/Validation errors (E-UICP-03xx)
  SanitizationFailed: 'E-UICP-0300',
  DataCommandInvalid: 'E-UICP-0301',
  SanitizeOutputInvalid: 'E-UICP-0302',
  
  // Adapter/State errors (E-UICP-04xx)
  WorkspaceNotReady: 'E-UICP-0400',
  WindowNotFound: 'E-UICP-0401',
  ComponentNotFound: 'E-UICP-0402',
  
  // Compute errors (E-UICP-05xx)
  ComputeTimeout: 'E-UICP-0500',
  ComputeCancelled: 'E-UICP-0501',
  ComputeCapabilityDenied: 'E-UICP-0502',
  ComputeResourceLimit: 'E-UICP-0503',
  ComputeRuntimeFault: 'E-UICP-0504',
  ComputeIODenied: 'E-UICP-0505',
  ComputeTaskNotFound: 'E-UICP-0506',
  ComputeNondeterministic: 'E-UICP-0507',
  
  // Unknown/Generic
  Unknown: 'E-UICP-0999',
} as const;

export type UICPErrorCodeT = typeof UICPErrorCode[keyof typeof UICPErrorCode];

// WHY: Helper constructors for common error scenarios
export const createBridgeError = (message: string, detail?: string, cause?: unknown): UICPError => {
  return new UICPError(UICPErrorCode.InvokeFailed, message, detail, cause);
};

export const createBridgeUnavailableError = (command: string): UICPError => {
  return new UICPError(
    UICPErrorCode.BridgeUnavailable,
    `Tauri bridge unavailable for command ${command}`,
  );
};

// WHY: Convert unknown error to UICPError with proper code
export const toUICPError = (error: unknown, fallbackCode: UICPErrorCodeT = UICPErrorCode.Unknown): UICPError => {
  if (error instanceof UICPError) {
    return error;
  }
  
  if (error instanceof Error) {
    return new UICPError(fallbackCode, error.message, undefined, error);
  }
  
  return new UICPError(fallbackCode, String(error));
};
