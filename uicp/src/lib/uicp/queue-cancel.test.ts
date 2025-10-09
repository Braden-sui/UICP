import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock applyBatch from adapter so we can observe calls
const applyBatchMock = vi.fn(async () => ({ success: true, applied: 1, errors: [] }));
vi.mock('./adapter', async () => {
  // dynamic import to avoid circulars in TS analysis
  return {
    applyBatch: applyBatchMock,
  };
});

import { enqueueBatch } from './queue';

describe('enqueueBatch with txn.cancel', () => {
  beforeEach(() => {
    applyBatchMock.mockClear();
  });

  it('clears queues and applies cancel immediately', async () => {
    const batch = [
      { op: 'txn.cancel', params: { id: 't' } },
    ] as const;
    const res = await enqueueBatch(batch as any);
    expect(res.success).toBe(true);
    expect(applyBatchMock).toHaveBeenCalledTimes(1);
    const [args] = applyBatchMock.mock.calls;
    const group = (args ?? []) as any[];
    expect(Array.isArray(group)).toBe(true);
    expect(group[0]?.op).toBe('txn.cancel');
  });
});
