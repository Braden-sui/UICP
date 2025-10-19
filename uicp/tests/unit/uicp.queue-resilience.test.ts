import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ApplyOutcome } from '../../src/lib/uicp/adapters/schemas';

const applyBatchMock = vi.fn(async (_batch: unknown): Promise<ApplyOutcome> => {
  throw new Error('applyBatchMock not initialized');
});
const attemptsByWindow = new Map<string, number>();

vi.mock('../../src/lib/uicp/telemetry', () => ({
  emitTelemetryEvent: vi.fn(),
}));

vi.mock('../../src/lib/uicp/adapters/adapter', () => ({
  applyBatch: (batch: unknown) => applyBatchMock(batch),
  deferBatchIfNotReady: () => null,
}));

import { enqueueBatch, clearAllQueues } from '../../src/lib/uicp/adapters/queue';

describe('uicp queue resilience', () => {
  beforeEach(() => {
    attemptsByWindow.clear();
    clearAllQueues();

    applyBatchMock.mockReset();
    applyBatchMock.mockImplementation(async (rawBatch: unknown): Promise<ApplyOutcome> => {
      const batch = rawBatch as Array<{ windowId?: string }>;
      const windowId = batch[0]?.windowId ?? '__global__';
      const attempt = attemptsByWindow.get(windowId) ?? 0;
      attemptsByWindow.set(windowId, attempt + 1);

      if (windowId === 'w1' && attempt === 0) {
        return {
          success: false,
          applied: 0,
          skippedDuplicates: 0,
          deniedByPolicy: 0,
          errors: ['boom'],
          batchId: `fail-${windowId}-${attempt}`,
        };
      }

      return {
        success: true,
        applied: batch.length,
        skippedDuplicates: 0,
        deniedByPolicy: 0,
        errors: [],
        batchId: `ok-${windowId}-${attempt}`,
      };
    });
  });

  afterEach(() => {
    applyBatchMock.mockReset();
    clearAllQueues();
    attemptsByWindow.clear();
  });

  it('continues processing batches for the same window after a failure', async () => {
    const timestamp = Date.now();
    const first = enqueueBatch([
      { op: 'dom.set', windowId: 'w1', idempotencyKey: `f1-${timestamp}`, params: { windowId: 'w1', target: '#root', html: '<div>1</div>' } },
    ] as unknown);
    const second = enqueueBatch([
      { op: 'dom.set', windowId: 'w1', idempotencyKey: `f2-${timestamp}`, params: { windowId: 'w1', target: '#root', html: '<div>2</div>' } },
    ] as unknown);
    const third = enqueueBatch([
      { op: 'dom.set', windowId: 'w2', idempotencyKey: `g1-${timestamp}`, params: { windowId: 'w2', target: '#root', html: '<div>3</div>' } },
    ] as unknown);

    const results = await Promise.allSettled([first, second, third]);

    for (const result of results) {
      if (result.status !== 'fulfilled') {
        throw result.reason;
      }
    }

    expect(applyBatchMock).toHaveBeenCalledTimes(3);
    expect(attemptsByWindow.get('w1')).toBe(2);
    expect(attemptsByWindow.get('w2')).toBe(1);

    const fulfilled = results as PromiseFulfilledResult<ApplyOutcome>[];
    expect(fulfilled[0].value.success).toBe(false);
    expect(fulfilled[0].value.errors).toContain('boom');
    expect(fulfilled[1].value.success).toBe(true);
    expect(fulfilled[1].value.applied).toBe(1);
    expect(fulfilled[2].value.success).toBe(true);
    expect(fulfilled[2].value.applied).toBe(1);
  });
});
