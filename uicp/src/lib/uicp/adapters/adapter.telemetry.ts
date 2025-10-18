/**
 * AdapterTelemetry Module
 * 
 * Centralized telemetry helpers for adapter v2.
 * All events include adapter_version: 2 for filtering.
 * 
 * PR 6: Extracted telemetry logic for modular adapter
 */

import { emitTelemetryEvent } from '../../telemetry';
import type { TelemetryEventName } from '../../telemetry/types';

export interface AdapterTelemetry {
  /**
   * Time an async operation and emit telemetry event
   */
  time<T>(name: TelemetryEventName, f: () => Promise<T>, fields?: Record<string, unknown>): Promise<T>;

  /**
   * Emit a telemetry event with adapter_version: 2
   */
  event(name: TelemetryEventName, fields?: Record<string, unknown>): void;

  /**
   * Emit an error telemetry event
   */
  error(name: TelemetryEventName, err: unknown, fields?: Record<string, unknown>): void;

  /**
   * Start a timer and return a function to stop it
   */
  startTimer(): () => number;
}

/**
 * Create an AdapterTelemetry instance.
 */
export const createAdapterTelemetry = (options?: {
  traceId?: string;
  batchId?: string;
}): AdapterTelemetry => {
  const traceId = options?.traceId ?? options?.batchId;
  if (!traceId) {
    throw new Error('Adapter telemetry requires traceId or batchId context');
  }

  const baseFields = {
    adapter_version: 2,
    traceId,
    ...(options?.batchId && { batchId: options.batchId }),
  };

  /**
   * Time an async operation
   */
  const time = async <T>(
    name: TelemetryEventName,
    f: () => Promise<T>,
    fields?: Record<string, unknown>
  ): Promise<T> => {
    const start = performance.now();
    try {
      const result = await f();
      const durationMs = Math.round(performance.now() - start);
      emitTelemetryEvent(name, {
        ...baseFields,
        ...fields,
        durationMs,
        status: 'ok',
      });
      return result;
    } catch (error) {
      const durationMs = Math.round(performance.now() - start);
      const message = error instanceof Error ? error.message : String(error);
      emitTelemetryEvent(name, {
        ...baseFields,
        ...fields,
        durationMs,
        status: 'error',
        data: { ...fields, error: message },
      });
      throw error;
    }
  };

  /**
   * Emit a telemetry event
   */
  const event = (name: TelemetryEventName, fields?: Record<string, unknown>): void => {
    emitTelemetryEvent(name, {
      ...baseFields,
      ...fields,
    });
  };

  /**
   * Emit an error telemetry event
   */
  const errorEvent = (name: TelemetryEventName, err: unknown, fields?: Record<string, unknown>): void => {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    emitTelemetryEvent(name, {
      ...baseFields,
      status: 'error',
      data: { ...fields, error: message, ...(stack && { stack }) },
    });
  };

  /**
   * Start a timer
   */
  const startTimer = (): (() => number) => {
    const start = performance.now();
    return () => Math.round(performance.now() - start);
  };

  return {
    time,
    event,
    error: errorEvent,
    startTimer,
  };
};

/**
 * Telemetry event names for adapter v2
 */
export const AdapterEvents = {
  APPLY_START: 'adapter.apply.start',
  APPLY_END: 'adapter.apply.end',
  APPLY_ABORT: 'adapter.apply.abort',
  WINDOW_CREATE: 'adapter.window.create',
  WINDOW_UPDATE: 'adapter.window.update',
  WINDOW_CLOSE: 'adapter.window.close',
  DOM_APPLY: 'adapter.dom.apply',
  COMPONENT_RENDER: 'adapter.component.render',
  COMPONENT_UNKNOWN: 'adapter.component.unknown',
  PERMISSION_CHECK: 'adapter.permission.check',
  PERMISSION_DENIED: 'adapter.permission.denied',
  VALIDATION_ERROR: 'adapter.validation.error',
  DEDUPE_SKIP: 'adapter.dedupe.skip',
} as const;
