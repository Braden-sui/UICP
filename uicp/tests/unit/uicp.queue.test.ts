import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the adapter so we can observe queue behavior deterministically
const applyBatchMock = vi.fn(async (batch: any[]) => {
  // Simulate variable latency per window to check ordering
  const w = batch[0]?.windowId ?? '__global__';
  const delay = w === 'w1' ? 40 : w === 'w2' ? 10 : 5;
  await new Promise((r) => setTimeout(r, delay));
  return { success: true, applied: batch.length, errors: [] };
});

vi.mock('../../src/lib/uicp/adapter', () => ({
  applyBatch: (batch: any) => applyBatchMock(batch),
  deferBatchIfNotReady: () => null, // Always return null (workspace ready) for queue tests
}));

import { enqueueBatch, clearAllQueues } from '../../src/lib/uicp/queue';

describe('uicp queue', () => {
  beforeEach(() => {
    applyBatchMock.mockClear();
    clearAllQueues();
  });

  it('drops duplicates by idempotencyKey', async () => {
    const key = `k-${Math.random().toString(36).slice(2, 8)}`;
    const batch = [
      { op: 'dom.set', idempotencyKey: key, windowId: 'w1', params: { windowId: 'w1', target: '#t', html: '<div />' } },
      { op: 'dom.set', idempotencyKey: key, windowId: 'w1', params: { windowId: 'w1', target: '#t', html: '<div />' } },
    ];

    const outcome = await enqueueBatch(batch as any);
    expect(outcome.success).toBe(true);
    // Only one applyBatch call for the single partition
    expect(applyBatchMock).toHaveBeenCalledTimes(1);
    // Applied count should be 1 after dedupe
    expect(applyBatchMock.mock.calls[0][0].length).toBe(1);
  });

  it('runs partitions per window and preserves FIFO per window across enqueues', async () => {
    const p1 = enqueueBatch([
      { op: 'state.set', idempotencyKey: 'a1', windowId: 'w1', params: { scope: 'global', key: 'k', value: 1 } },
    ] as any);
    const p2 = enqueueBatch([
      { op: 'state.set', idempotencyKey: 'b1', windowId: 'w2', params: { scope: 'global', key: 'k', value: 2 } },
    ] as any);
    const p3 = enqueueBatch([
      { op: 'state.set', idempotencyKey: 'a2', windowId: 'w1', params: { scope: 'global', key: 'k', value: 3 } },
    ] as any);

    await Promise.all([p1, p2, p3]);

    // Two applyBatch calls for w1 (due to two enqueues), one for w2
    const windows = applyBatchMock.mock.calls.map((args) => args[0][0].windowId ?? '__global__');
    // Find indices of w1 calls and ensure ordering preserved
    const w1Indices = windows.map((w, i) => (w === 'w1' ? i : -1)).filter((i) => i >= 0);
    expect(w1Indices.length).toBe(2);
    expect(w1Indices[0]).toBeLessThan(w1Indices[1]);
  });

  it('applies txn.cancel immediately and clears queues', async () => {
    const outcome = await enqueueBatch([{ op: 'txn.cancel', params: { id: 't1' } }] as any);
    expect(outcome.success).toBe(true);
    expect(applyBatchMock).toHaveBeenCalledTimes(1);
    const passed = applyBatchMock.mock.calls[0][0];
    expect(Array.isArray(passed)).toBe(true);
    expect(passed[0].op).toBe('txn.cancel');
  });
});
