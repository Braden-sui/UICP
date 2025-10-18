/**
 * Adapter Type Definitions
 * 
 * Shared types for adapter v2 modular implementation.
 * Re-exports stable types from schema package and defines adapter-specific types.
 */

// Re-export stable types from schema package
export type {
  WindowId,
  ComponentId,
  OperationNameT,
  OperationParamMap,
  Envelope,
  Batch,
  SafeHtml,
} from '../../schema';


/**
 * Outcome of applying an envelope or batch.
 * 
 * CRITICAL: Use skippedDuplicates (not skippedDupes) for consistency.
 */
export interface ApplyOutcome {
  /** Unique identifier for this envelope/batch */
  id?: string;
  
  /** Whether the overall operation succeeded */
  success: boolean;
  
  /** Number of operations successfully applied */
  applied: number;
  
  /** Number of operations skipped due to duplication (idempotency) */
  skippedDuplicates: number;
  
  /** Number of operations denied by permission policy */
  deniedByPolicy: number;
  
  /** List of error messages encountered during apply */
  errors: string[];
  
  /** Stable batch identifier for tracking */
  batchId: string;
  
  /** Hash of operations in this batch for deduplication */
  opsHash?: string;
}

/**
 * Options for apply operations
 */
export interface ApplyOptions {
  /** Run identifier for correlation (from orchestrator) */
  runId?: string;
  
  /** Allow partial application (don't fail entire batch on first error) */
  allowPartial?: boolean;
  
  /** Pre-computed batch identifier (for idempotency) */
  batchId?: string;
  
  /** Pre-computed operations hash (for deduplication) */
  opsHash?: string;
}

/**
 * Window lifecycle event types
 */
export type WindowLifecycleEvent =
  | { type: 'created'; id: string; title: string }
  | { type: 'updated'; id: string; title: string }
  | { type: 'destroyed'; id: string; title?: string };

/**
 * Window lifecycle event listener
 */
export type WindowLifecycleListener = (event: WindowLifecycleEvent) => void;

/**
 * Internal window record structure
 */
export interface WindowRecord {
  id: string;
  wrapper: HTMLElement;
  content: HTMLElement;
  titleText: HTMLElement;
  styleSelector: string;
}

/**
 * Component record structure
 */
export interface ComponentRecord {
  id: string;
  element: HTMLElement;
}

/**
 * State storage scopes
 */
export type StateScope = 'window' | 'workspace' | 'global';

/**
 * UI event callback type
 */
export type UIEventCallback = (payload: {
  event: string;
  data: Record<string, unknown>;
}) => void;

/**
 * Permission decision result
 */
export type PermissionDecision = 'granted' | 'denied';

/**
 * Permission scope categories
 */
export type PermissionScope =
  | 'window'
  | 'dom'
  | 'components';

/**
 * Permission check context
 */
export interface PermissionContext {
  operation: string;
  params: unknown;
  traceId?: string;
  windowId?: string;
  envelopeId?: string;
}

/**
 * Result wrapper for operations that can fail
 */
export type OperationResult<T> =
  | { success: true; value: T }
  | { success: false; error: string };
