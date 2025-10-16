import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { Batch } from '../schemas';
import type { ApplyOutcome } from '../adapter';

vi.mock('../adapter', async () => {
  return {
    // WHY: In these tests we only need a deterministic, successful apply that
    // returns the batch length. This isolates queue behavior around txn.cancel.
    // INVARIANT: `applied` equals `_batch.length`; no side effects.
    applyBatch: vi.fn(async (_batch: Batch): Promise<ApplyOutcome> => ({
      success: true,
      applied: _batch.length ?? 1,
      errors: [],
    })),
    deferBatchIfNotReady: () => null, // WHY: Queue tests assume workspace ready; skip deferral logic.
  };
});

import { enqueueBatch, clearAllQueues } from '../queue';
import { applyBatch } from '../adapter';

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
