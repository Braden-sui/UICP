import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { Batch } from '../adapters/schemas';
import type { ApplyOutcome } from '../adapters/adapter';

vi.mock('../adapters/adapter', async () => {
  return {
    // WHY: In these tests we only need a deterministic, successful apply that
    // returns the batch length. This isolates queue behavior around txn.cancel.
    // INVARIANT: `applied` equals `_batch.length`; no side effects.
    applyBatch: vi.fn(async (_batch: Batch): Promise<ApplyOutcome> => ({
      success: true,
      applied: _batch.length ?? 1,
      errors: [],
      skippedDuplicates: 0,
      deniedByPolicy: 0,
      batchId: '',
    })),
    deferBatchIfNotReady: () => null, // WHY: Queue tests assume workspace ready; skip deferral logic.
  };
});

import { enqueueBatch, clearAllQueues } from '../adapters/queue';
import { applyBatch } from '../adapters/adapter';

// SAFETY: Vitest's Mock<T> accepts a single function type parameter.
const mockedApply = applyBatch as unknown as Mock<(batch: Batch) => Promise<ApplyOutcome>>;

describe('queue txn.cancel', () => {
  beforeEach(() => {
    clearAllQueues();
    mockedApply.mockClear?.();
  });

  it('short-circuits and applies cancel batch immediately', async () => {
    const batch = [
      { op: 'txn.cancel' as const, params: { id: 't' } },
    ];
    const result = await enqueueBatch(batch);
    expect(result.success).toBe(true);
    expect(result.applied).toBe(1);
    expect(mockedApply).toHaveBeenCalledTimes(1);
    expect(mockedApply).toHaveBeenCalledWith(batch);
  });
});
