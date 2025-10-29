import type { Batch } from "./schemas";
import { validateBatch } from "./schemas";
import { applyBatch, deferBatchIfNotReady, type ApplyOutcome } from "./adapter";
import { emitTelemetryEvent } from "../../telemetry";
import { lintBatch, formatLintError } from "./batchLinter";
import { useAppStore } from "../../../state/app";

// Per-window FIFO queue with idempotency and txn cancel support.
// - Commands with the same windowId run sequentially
// - Different windows run in parallel
// - idempotencyKey is used to drop duplicates across the lifetime of the app session
// - txn.cancel clears all pending queues immediately

const GLOBAL_KEY = '__global__';
const IDEMPOTENCY_TTL_MS = 15 * 60 * 1000; // 15 minutes
const CLEANUP_THRESHOLD = 1000; // Cleanup when map exceeds this size

type AppliedSummary = { windowId: string; applied: number; ms: number };
const appliedListeners = new Set<(summary: AppliedSummary) => void>();

// Back-compat: overwrite with a single listener
export const setQueueAppliedListener = (handler: (summary: AppliedSummary) => void) => {
  appliedListeners.clear();
  appliedListeners.add(handler);
};

// New API: allow multiple listeners and return unlisten
export const addQueueAppliedListener = (handler: (summary: AppliedSummary) => void): (() => void) => {
  appliedListeners.add(handler);
  return () => {
    appliedListeners.delete(handler);
  };
};

// Tracks seen idempotency keys with timestamps for TTL-based expiration.
const seenIdempotency = new Map<string, number>();

// Chains per-window execution promises to ensure FIFO.
const chains = new Map<string, Promise<ApplyOutcome>>();

const getSkippedCount = (outcome: ApplyOutcome): number => outcome.skippedDuplicates ?? 0;

const createEmptyOutcome = (): ApplyOutcome => ({
  success: true,
  applied: 0,
  skippedDuplicates: 0,
  deniedByPolicy: 0,
  errors: [],
  batchId: '',
});

// Clears the queues; does not modify DOM. Callers should enqueue a txn.cancel batch to reset UI if needed.
export const clearAllQueues = () => {
  chains.clear();
  seenIdempotency.clear();
};

// Filters envelopes by idempotencyKey; returns filtered Batch, drop count, and drops grouped by trace.
const filterByIdempotency = (
  batch: Batch,
): { filtered: Batch; dropped: number; dropsByTrace: Map<string, number> } => {
  const now = Date.now();
  const dropsByTrace = new Map<string, number>();

  const filtered = batch.filter((env) => {
    const key = env.idempotencyKey;
    if (!key) return true;

    const seen = seenIdempotency.get(key);
    if (seen && now - seen < IDEMPOTENCY_TTL_MS) {
      if (env.traceId) {
        dropsByTrace.set(env.traceId, (dropsByTrace.get(env.traceId) ?? 0) + 1);
      }
      return false;
    }

    seenIdempotency.set(key, now);
    return true;
  });

  // Lazy cleanup: remove expired entries when map grows beyond threshold
  if (seenIdempotency.size > CLEANUP_THRESHOLD) {
    for (const [k, ts] of seenIdempotency.entries()) {
      if (now - ts > IDEMPOTENCY_TTL_MS) {
        seenIdempotency.delete(k);
      }
    }
  }

  return { filtered, dropped: batch.length - filtered.length, dropsByTrace };
};

// Partitions the batch by windowId (or GLOBAL_KEY when absent) while preserving order within each partition.
const partitionByWindow = (batch: Batch): Map<string, Batch> => {
  const groups = new Map<string, Batch>();
  for (const env of batch) {
    const key = env.windowId ?? GLOBAL_KEY;
    const list = groups.get(key) ?? [];
    list.push(env);
    groups.set(key, list);
  }
  return groups;
};

const mergeOutcomes = (outcomes: ApplyOutcome[]): ApplyOutcome =>
  outcomes.reduce<ApplyOutcome>(
    (acc, cur) => {
      const totalSkipped = getSkippedCount(acc) + getSkippedCount(cur);
      return {
        success: acc.success && cur.success,
        applied: acc.applied + cur.applied,
        skippedDuplicates: totalSkipped,
        deniedByPolicy: acc.deniedByPolicy + cur.deniedByPolicy,
        errors: acc.errors.concat(cur.errors),
        batchId: acc.batchId ?? cur.batchId,
        opsHash: acc.opsHash ?? cur.opsHash,
      };
    },
    createEmptyOutcome(),
  );

// Enqueue a batch for application respecting per-window FIFO and idempotency.
export const enqueueBatch = async (input: Batch | unknown): Promise<ApplyOutcome> => {
  // Allow callers to pass unknown; validate/normalize to Batch.
  const batch = Array.isArray(input) ? validateBatch(input) : validateBatch(input as unknown);

  // Guard: defer batch if workspace root is not yet registered (race condition protection)
  const deferred = deferBatchIfNotReady(batch);
  if (deferred) return deferred;

  // Handle txn.cancel upfront: clear queues and apply the cancel immediately.
  const hasTxnCancel = batch.some((env) => env.op === 'txn.cancel');
  if (hasTxnCancel) {
    clearAllQueues();
    // Apply the cancel batch immediately and short-circuit.
    const t0 = performance.now();
    const outcome = await applyBatch(batch);
    const ms = Math.max(0, performance.now() - t0);
    for (const fn of appliedListeners) fn({ windowId: GLOBAL_KEY, applied: outcome.applied, ms });
    return outcome;
  }

  const { filtered, dropsByTrace } = filterByIdempotency(batch);
  for (const [traceId, count] of dropsByTrace.entries()) {
    emitTelemetryEvent('queue_dropped_idempotent', {
      traceId,
      span: 'queue',
      status: 'dropped',
      data: {
        count,
        ttlMs: IDEMPOTENCY_TTL_MS,
      },
    });
  }
  if (!filtered.length) {
    return createEmptyOutcome();
  }

  // Pre-apply linter gate: reject low-value batches
  const lintResult = lintBatch(filtered);
  if (!lintResult.ok) {
    const errorMsg = formatLintError(lintResult);
    // Emit telemetry for rejected batches
    const firstTrace = filtered.find((env) => env.traceId)?.traceId;
    if (firstTrace) {
      emitTelemetryEvent('batch_lint_rejected', {
        traceId: firstTrace,
        span: 'queue',
        status: 'error',
        data: {
          code: lintResult.code,
          reason: lintResult.reason,
          batchSize: filtered.length,
        },
      });
    }
    throw new Error(errorMsg);
  }

  const partitions = partitionByWindow(filtered);
  const results: Promise<ApplyOutcome>[] = [];

  for (const [windowId, group] of partitions.entries()) {
    // INVARIANT: Capture ALL loop variables to prevent closure sharing bugs
    // JavaScript for-of creates new bindings per iteration, but we're explicit here
    const capturedWindowId = windowId;
    const capturedGroup = group;
    
    const traceCounts = new Map<string, number>();
    for (const env of capturedGroup) {
      if (!env.traceId) continue;
      traceCounts.set(env.traceId, (traceCounts.get(env.traceId) ?? 0) + 1);
    }
    const capturedTraceCounts = traceCounts;
    
    const run = async (): Promise<ApplyOutcome> => {
      const t0 = performance.now();
      try {
        const app = useAppStore.getState();
        app.transitionOrchestrator('ApplyStart', { windowId: capturedWindowId, batchSize: capturedGroup.length });
        app.transitionAgentPhase('applying');
      } catch {
        // ignore orchestrator transition errors in queue path
      }
      const outcome = await applyBatch(capturedGroup);
      const ms = Math.max(0, performance.now() - t0);
      if (outcome.success) {
        for (const fn of appliedListeners) fn({ windowId: capturedWindowId, applied: outcome.applied, ms });
        try {
          const app = useAppStore.getState();
          app.transitionOrchestrator('ApplySucceeded', { windowId: capturedWindowId, applied: outcome.applied, ms });
          app.transitionAgentPhase('complete', { applyMs: Math.round(ms) });
        } catch {
          // ignore orchestrator transition errors in queue path
        }
      }
      for (const [traceId, count] of capturedTraceCounts.entries()) {
        emitTelemetryEvent('enqueue_applied', {
          traceId,
          span: 'queue',
          durationMs: ms,
          status: outcome.success ? 'ok' : 'error',
          data: {
            windowId: capturedWindowId,
            applied: outcome.applied,
            skippedDupes: getSkippedCount(outcome),
            batchId: outcome.batchId,
            errors: outcome.success ? undefined : outcome.errors.slice(0, 3),
            traceCommands: count,
          },
        });
      }
      return outcome;
    };

    const prev = chains.get(capturedWindowId) ?? Promise.resolve(createEmptyOutcome());
    const next = prev.then(run)
      .catch((err) => ({
        success: false,
        applied: 0,
        skippedDuplicates: 0,
        deniedByPolicy: 0,
        errors: [String(err)],
        batchId: '',
      }));

    chains.set(capturedWindowId, next);
    results.push(next);
  }

  const outcomes = await Promise.all(results);
  return mergeOutcomes(outcomes);
};

// WHY: End-to-end tests need a stable entry point to drive batches without relying on internal module resolution.
// SAFETY: Exposing enqueueBatch on window is idempotent and mirrors existing adapter APIs; tests only use it in controlled environments.
if (typeof window !== 'undefined') {
  const w = window as typeof window & { __UICP_TEST_ENQUEUE__?: typeof enqueueBatch };
  Object.defineProperty(w, '__UICP_TEST_ENQUEUE__', {
    configurable: true,
    enumerable: false,
    value: enqueueBatch,
    writable: false,
  });
}
