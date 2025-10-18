/**
 * Lifecycle Orchestrator (Adapter v2)
 * 
 * Thin coordinator that routes operations to specialized modules.
 * This is the NEW modular implementation activated by UICP_ADAPTER_V2=1.
 * 
 * PR 7: Thin orchestrator that wires all modules together
 * 
 * INVARIANTS:
 * - No direct DOM/window manipulation (delegate to modules)
 * - All HTML sanitized (via DomApplier)
 * - All permissions checked (via PermissionGate)
 * - All operations idempotent (via module implementations)
 * - All events tracked (via AdapterTelemetry)
 */

import type { Envelope, Batch } from '../../schema';
import type { ApplyOutcome, ApplyOptions, PermissionScope } from './adapter.types';
import { validateEnvelope } from './adapter.schema';
import { AdapterError } from './adapter.errors';
import { createWindowManager } from './windowManager';
import { createDomApplier } from './domApplier';
import { createComponentRenderer } from './componentRenderer';
import { createPermissionGate } from './permissionGate';
import { createAdapterTelemetry, AdapterEvents } from './adapter.telemetry';
import { createId } from '../../utils';

/**
 * Workspace root element (must be registered before applying operations)
 */
let workspaceRoot: HTMLElement | null = null;

/**
 * Register workspace root element.
 * Must be called before applyBatch.
 */
export const registerWorkspaceRoot = (element: HTMLElement): void => {
  workspaceRoot = element;
};

/**
 * Apply a batch of operations (main entry point for adapter v2).
 * 
 * This is the thin orchestrator that:
 * 1. Validates envelopes
 * 2. Routes to appropriate modules
 * 3. Aggregates outcomes
 * 4. Emits telemetry
 */
export const applyBatch = async (
  batch: Batch,
  options?: ApplyOptions
): Promise<ApplyOutcome> => {
  const batchId = options?.batchId ?? createId('batch');
  const telemetry = createAdapterTelemetry({
    traceId: options?.runId,
    batchId,
  });

  // Ensure workspace root is registered
  if (!workspaceRoot) {
    const error = new AdapterError('Adapter.Internal', 'Workspace root not registered');
    telemetry.error(AdapterEvents.APPLY_ABORT, error, { reason: 'no_workspace_root' });
    return {
      success: false,
      applied: 0,
      skippedDuplicates: 0,
      deniedByPolicy: 0,
      errors: [error.message],
      batchId,
    };
  }

  telemetry.event(AdapterEvents.APPLY_START, {
    opCount: batch.length,
    runId: options?.runId,
  });

  // Initialize modules
  const windowManager = createWindowManager(workspaceRoot);
  const domApplier = createDomApplier(windowManager, { enableDeduplication: true });
  const componentRenderer = createComponentRenderer(domApplier, {
    onUnknownComponent: (type) => {
      telemetry.event(AdapterEvents.COMPONENT_UNKNOWN, { type });
    },
  });
  const permissionGate = createPermissionGate();

  // Aggregate outcome
  const outcome: ApplyOutcome = {
    success: true,
    applied: 0,
    skippedDuplicates: 0,
    deniedByPolicy: 0,
    errors: [],
    batchId,
    opsHash: options?.opsHash,
  };

  // Process each envelope
  for (let i = 0; i < batch.length; i++) {
    const envelope = batch[i];
    
    try {
      // Validate envelope structure
      const validated = validateEnvelope(envelope);

      // Check permissions by scoped op
      const permission = await permissionGate.require(scopeFromOp(validated.op), {
        operation: validated.op,
        params: validated.params,
        traceId: options?.runId,
        envelopeId: validated.id,
      });

      if (permission === 'denied') {
        telemetry.event(AdapterEvents.PERMISSION_DENIED, {
          op: validated.op,
          envelopeId: validated.id,
        });
        outcome.deniedByPolicy += 1;
        outcome.errors.push(`Permission denied: ${validated.op}`);
        continue;
      }

      // Route to appropriate module
      await routeOperation(validated, {
        windowManager,
        domApplier,
        componentRenderer,
        telemetry,
        outcome,
      });

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome.errors.push(`Op ${i}: ${message}`);
      
      if (error instanceof AdapterError) {
        telemetry.error(AdapterEvents.VALIDATION_ERROR, error, { opIndex: i, op: envelope.op, errorCode: error.code });
      } else {
        telemetry.error(AdapterEvents.VALIDATION_ERROR, error, { opIndex: i, op: envelope.op });
      }

      // Stop on first error unless allowPartial
      if (!options?.allowPartial) {
        break;
      }
    }
  }

  // Finalize outcome
  outcome.success = outcome.errors.length === 0;

  telemetry.event(AdapterEvents.APPLY_END, {
    applied: outcome.applied,
    skippedDuplicates: outcome.skippedDuplicates,
    errors: outcome.errors.length,
    success: outcome.success,
  });

  return outcome;
};

/**
 * Route operation to appropriate module.
 * This is where the thin orchestrator delegates to specialized modules.
 */
const routeOperation = async (
  envelope: Envelope,
  context: {
    windowManager: ReturnType<typeof createWindowManager>;
    domApplier: ReturnType<typeof createDomApplier>;
    componentRenderer: ReturnType<typeof createComponentRenderer>;
    telemetry: ReturnType<typeof createAdapterTelemetry>;
    outcome: ApplyOutcome;
  }
): Promise<void> => {
  const { windowManager, domApplier, componentRenderer, telemetry, outcome } = context;

  switch (envelope.op) {
    case 'window.create': {
      const params = envelope.params as Parameters<typeof windowManager.create>[0];
      const { windowId, applied } = await windowManager.create(params);
      telemetry.event(AdapterEvents.WINDOW_CREATE, { windowId });
      if (applied) outcome.applied += 1;
      break;
    }

    case 'window.move': {
      const params = envelope.params as Parameters<typeof windowManager.move>[0];
      const { applied } = await windowManager.move(params);
      if (applied) outcome.applied += 1;
      break;
    }

    case 'window.resize': {
      const params = envelope.params as Parameters<typeof windowManager.resize>[0];
      const { applied } = await windowManager.resize(params);
      if (applied) outcome.applied += 1;
      break;
    }

    case 'window.focus': {
      const params = envelope.params as Parameters<typeof windowManager.focus>[0];
      const { applied } = await windowManager.focus(params);
      if (applied) outcome.applied += 1;
      break;
    }

    case 'window.close': {
      const params = envelope.params as Parameters<typeof windowManager.close>[0];
      const { applied } = await windowManager.close(params);
      telemetry.event(AdapterEvents.WINDOW_CLOSE, { windowId: params.id });
      if (applied) outcome.applied += 1;
      break;
    }

    case 'dom.set':
    case 'dom.replace':
    case 'dom.append': {
      const params = envelope.params as Parameters<typeof domApplier.apply>[0];
      const result = await domApplier.apply(params);
      telemetry.event(AdapterEvents.DOM_APPLY, {
        windowId: params.windowId,
        target: params.target,
        mode: params.mode,
        applied: result.applied,
        skipped: result.skippedDuplicates,
      });
      outcome.applied += result.applied;
      outcome.skippedDuplicates += result.skippedDuplicates;
      break;
    }

    case 'component.render': {
      const params = envelope.params as Parameters<typeof componentRenderer.render>[0];
      await componentRenderer.render(params);
      telemetry.event(AdapterEvents.COMPONENT_RENDER, {
        windowId: params.windowId,
        type: params.type,
      });
      outcome.applied++;
      break;
    }

    default:
      throw new AdapterError('Adapter.ValidationFailed', `Unknown operation: ${envelope.op}`);
  }
};

/**
 * Get workspace root (for testing/debugging)
 */
export const getWorkspaceRoot = (): HTMLElement | null => {
  return workspaceRoot;
};

/**
 * Clear workspace root (for testing cleanup)
 */
export const clearWorkspaceRoot = (): void => {
  workspaceRoot = null;
};

// Map op -> permission scope (keep in this file for now, move to schema if it grows)
function scopeFromOp(op: Envelope['op']): PermissionScope {
  switch (op) {
    case 'window.create':
    case 'window.move':
    case 'window.resize':
    case 'window.focus':
    case 'window.close':
      return 'window';
    case 'dom.set':
    case 'dom.replace':
    case 'dom.append':
      return 'dom';
    case 'component.render':
      return 'components';
    default:
      // Unknown ops never reach permission, they throw earlier
      return 'dom';
  }
}
