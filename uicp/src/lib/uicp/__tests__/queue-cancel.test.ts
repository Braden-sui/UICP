import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../adapter', async () => {
  return {
    applyBatch: vi.fn(async (_batch: any) => ({ success: true, applied: _batch.length ?? 1, errors: [] })),
  };
});

import { enqueueBatch, clearAllQueues } from '../queue';
import { applyBatch } from '../adapter';

const mockedApply = applyBatch as unknown as ReturnType<typeof vi.fn> & { mock: any };

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
