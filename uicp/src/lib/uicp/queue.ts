import type { Batch } from "./schemas";
import { validateBatch } from "./schemas";
import { applyBatch, deferBatchIfNotReady, type ApplyOutcome } from "./adapter";

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

// Clears the queues; does not modify DOM. Callers should enqueue a txn.cancel batch to reset UI if needed.
export const clearAllQueues = () => {
  chains.clear();
  seenIdempotency.clear();
};

// Filters envelopes by idempotencyKey; returns filtered Batch and how many were dropped.
const filterByIdempotency = (batch: Batch): { filtered: Batch; dropped: number } => {
  const now = Date.now();

  const filtered = batch.filter((env) => {
    const key = env.idempotencyKey;
    if (!key) return true;

    const seen = seenIdempotency.get(key);
    if (seen && now - seen < IDEMPOTENCY_TTL_MS) return false;

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

  return { filtered, dropped: batch.length - filtered.length };
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

const mergeOutcomes = (outcomes: ApplyOutcome[]): ApplyOutcome => {
  return outcomes.reduce<ApplyOutcome>(
    (acc, cur) => ({
      success: acc.success && cur.success,
      applied: acc.applied + cur.applied,
      errors: acc.errors.concat(cur.errors),
    }),
    { success: true, applied: 0, errors: [] },
  );
};

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

  const { filtered } = filterByIdempotency(batch);
  if (!filtered.length) {
    return { success: true, applied: 0, errors: [] };
  }

  const partitions = partitionByWindow(filtered);
  const results: Promise<ApplyOutcome>[] = [];

  for (const [windowId, group] of partitions.entries()) {
    const run = async (): Promise<ApplyOutcome> => {
      const t0 = performance.now();
      const outcome = await applyBatch(group);
      const ms = Math.max(0, performance.now() - t0);
      if (outcome.success) {
        for (const fn of appliedListeners) fn({ windowId, applied: outcome.applied, ms });
      }
      return outcome;
    };

    const prev = chains.get(windowId) ?? Promise.resolve({ success: true, applied: 0, errors: [] });
    const next = prev
      .then(run)
      .catch((err) => ({ success: false, applied: 0, errors: [String(err)] }));

    chains.set(windowId, next);
    results.push(next);
  }

  const outcomes = await Promise.all(results);
  return mergeOutcomes(outcomes);
};
