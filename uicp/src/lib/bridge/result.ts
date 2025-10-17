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

// Standardized UICP error codes
export const UICPErrorCode = {
  // Bridge/Tauri errors (E-UICP-1xx)
  BridgeUnavailable: 'E-UICP-100',
  InvokeFailed: 'E-UICP-101',
  EventListenerFailed: 'E-UICP-102',
  
  // Sanitization/Validation errors (E-UICP-3xx)
  SanitizationFailed: 'E-UICP-300',
  DataCommandInvalid: 'E-UICP-301',
  SanitizeOutputInvalid: 'E-UICP-302',
  
  // Adapter/State errors (E-UICP-4xx)
  WorkspaceNotReady: 'E-UICP-400',
  WindowNotFound: 'E-UICP-401',
  ComponentNotFound: 'E-UICP-402',
  
  // Compute errors (E-UICP-5xx)
  ComputeTimeout: 'E-UICP-500',
  ComputeCancelled: 'E-UICP-501',
  ComputeCapabilityDenied: 'E-UICP-502',
  ComputeResourceLimit: 'E-UICP-503',
  ComputeRuntimeFault: 'E-UICP-504',
  ComputeIODenied: 'E-UICP-505',
  ComputeTaskNotFound: 'E-UICP-506',
  ComputeNondeterministic: 'E-UICP-507',
  
  // Unknown/Generic
  Unknown: 'E-UICP-999',
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
