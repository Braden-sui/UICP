import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOllamaAggregator } from '../stream';
import type { Batch } from '../adapters/schemas';
import type { ApplyOutcome } from '../adapters/adapter';

describe('stream cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('processDelta short-circuits after cancel', async () => {
    const onBatchMock = vi.fn();
    const agg = createOllamaAggregator(onBatchMock);

    await agg.processDelta('some text');
    agg.cancel();
    await agg.processDelta('more text after cancel');

    expect(agg.isCancelled()).toBe(true);
    // No batch should be applied since no flush was called
    expect(onBatchMock).not.toHaveBeenCalled();
  });

  it('flush returns cancelled status and skips batch application', async () => {
    const onBatchMock = vi.fn();
    const agg = createOllamaAggregator(onBatchMock);

    // Simulate a valid WIL batch
    await agg.processDelta('set state foo to bar in workspace\n');
    agg.cancel();

    const result = await agg.flush();

    expect(result.cancelled).toBe(true);
    expect(onBatchMock).not.toHaveBeenCalled();
  });

  it('normal flush returns cancelled false', async () => {
    const onBatchMock = vi.fn().mockResolvedValue({ success: true, applied: 1, errors: [], skippedDupes: 0 } as ApplyOutcome);
    const agg = createOllamaAggregator(onBatchMock);

    // Valid WIL batch
    await agg.processDelta('set state test to value in workspace\n');
    const result = await agg.flush();

    expect(result.cancelled).toBe(false);
    expect(onBatchMock).toHaveBeenCalledTimes(1);
  });

  it('cancel before first delta prevents all processing', async () => {
    const onBatchMock = vi.fn();
    const agg = createOllamaAggregator(onBatchMock);

    agg.cancel();
    await agg.processDelta('set state foo to bar in workspace\n');
    const result = await agg.flush();

    expect(result.cancelled).toBe(true);
    expect(onBatchMock).not.toHaveBeenCalled();
  });

  it('cancel during accumulation prevents flush', async () => {
    const onBatchMock = vi.fn();
    const agg = createOllamaAggregator(onBatchMock);

    await agg.processDelta('set state foo to bar');
    agg.cancel();
    await agg.processDelta(' more\n');
    const result = await agg.flush();

    expect(result.cancelled).toBe(true);
    expect(onBatchMock).not.toHaveBeenCalled();
  });

  it('soak test: rapid start/stop with timing assertions', async () => {
    // WHY: Prove that cancellation prevents ghost echoes even under rapid start/stop cycles
    const ITERATIONS = 20;
    const appliedBatches: Batch[] = [];
    let postCancelItems = 0;

    const onBatchMock = vi.fn(async (batch: Batch) => {
      appliedBatches.push(batch);
      return { success: true, applied: batch.length, errors: [], skippedDupes: 0 } as ApplyOutcome;
    });

    for (let i = 0; i < ITERATIONS; i++) {
      const agg = createOllamaAggregator(onBatchMock);
      const delayMs = Math.floor(Math.random() * 100) + 50; // 50-150ms

      // Start feeding deltas
      const feedPromise = (async () => {
        for (let j = 0; j < 5; j++) {
          if (agg.isCancelled()) {
            postCancelItems++;
            break;
          }
          await agg.processDelta(`set state iter${i}_delta${j} to value${j} in workspace\n`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })();

      // Cancel after random delay
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      agg.cancel();

      // Wait for feed to finish
      await feedPromise;

      // Attempt flush
      const result = await agg.flush();
      expect(result.cancelled).toBe(true);
    }

    // INVARIANT: Post-cancel items should be minimal (best-effort boundary)
    // WHY: Some deltas may be in-flight when cancel() is called
    expect(postCancelItems).toBeLessThanOrEqual(ITERATIONS * 2);

    // INVARIANT: No batches should be applied after cancellation
    expect(onBatchMock).not.toHaveBeenCalled();
  });

  it('soak test: verify no batch leaks with concurrent cancellation', async () => {
    const STREAMS = 10;
    const appliedBatches: number[] = [];
    
    const onBatchMock = vi.fn(async (batch: Batch) => {
      appliedBatches.push(batch.length);
      return { success: true, applied: batch.length, errors: [], skippedDupes: 0 } as ApplyOutcome;
    });

    const streamPromises = Array.from({ length: STREAMS }, async (_, streamIdx) => {
      const agg = createOllamaAggregator(onBatchMock);
      
      // Feed some deltas
      for (let i = 0; i < 3; i++) {
        await agg.processDelta(`set state s${streamIdx}_d${i} to val in workspace\n`);
      }

      // Cancel some streams, let others complete
      if (streamIdx % 2 === 0) {
        agg.cancel();
        const result = await agg.flush();
        expect(result.cancelled).toBe(true);
        return { cancelled: true };
      } else {
        const result = await agg.flush();
        expect(result.cancelled).toBe(false);
        return { cancelled: false };
      }
    });

    const results = await Promise.all(streamPromises);
    const cancelledCount = results.filter((r) => r.cancelled).length;
    const completedCount = results.filter((r) => !r.cancelled).length;

    // INVARIANT: Half cancelled, half completed
    expect(cancelledCount).toBe(STREAMS / 2);
    expect(completedCount).toBe(STREAMS / 2);

    // INVARIANT: Only completed streams applied batches
    expect(onBatchMock).toHaveBeenCalledTimes(completedCount);
  });

  it('empty batch does not trigger onBatch callback', async () => {
    const onBatchMock = vi.fn();
    const agg = createOllamaAggregator(onBatchMock);

    // No valid operations
    await agg.processDelta('just some commentary\n');
    const result = await agg.flush();

    expect(result.cancelled).toBe(false);
    expect(onBatchMock).not.toHaveBeenCalled();
  });

  it('cancelled aggregator remains cancelled after multiple cancel calls', async () => {
    const agg = createOllamaAggregator();

    agg.cancel();
    agg.cancel();
    agg.cancel();

    expect(agg.isCancelled()).toBe(true);

    await agg.processDelta('test\n');
    const result = await agg.flush();
    expect(result.cancelled).toBe(true);
  });

  it('soak test: measure post-cancel delta arrival rate', async () => {
    // WHY: Quantify the "ghost echo" boundary - how many deltas arrive after cancel?
    const TRIALS = 50;
    const postCancelCounts: number[] = [];

    for (let trial = 0; trial < TRIALS; trial++) {
      let postCancelDeltas = 0;
      const agg = createOllamaAggregator();

      // Feed deltas in tight loop
      const feedPromise = (async () => {
        for (let i = 0; i < 100; i++) {
          if (agg.isCancelled()) {
            postCancelDeltas++;
          }
          await agg.processDelta(`delta${i}\n`);
        }
      })();

      // Cancel after 5ms
      await new Promise((resolve) => setTimeout(resolve, 5));
      agg.cancel();

      await feedPromise;
      postCancelCounts.push(postCancelDeltas);
    }

    const maxPostCancel = Math.max(...postCancelCounts);
    const avgPostCancel = postCancelCounts.reduce((a, b) => a + b, 0) / TRIALS;

    // INVARIANT: Post-cancel deltas should be minimal (assert max <= reasonable threshold)
    // WHY: With 5ms cancel delay and 100 iterations, we expect most to be cancelled
    expect(maxPostCancel).toBeLessThan(10);
    expect(avgPostCancel).toBeLessThan(5);

    if (import.meta.env.DEV) {
      console.debug('[stream-cancel] post-cancel stats', {
        trials: TRIALS,
        max: maxPostCancel,
        avg: avgPostCancel.toFixed(2),
      });
    }
  });

  it('cancelled stream prevents batch from reaching onBatch callback', async () => {
    // WHY: Verify that cancelled streams prevent autoApply by not invoking onBatch
    // INVARIANT: onBatch should never be called if cancel() happens before flush()
    const onBatchMock = vi.fn();
    const agg = createOllamaAggregator(onBatchMock);

    // Build valid batch
    await agg.processDelta('set state key to value in workspace\n');
    
    // Cancel before flush
    agg.cancel();
    
    const result = await agg.flush();
    
    expect(result.cancelled).toBe(true);
    // INVARIANT: onBatch callback never invoked, so autoApply is effectively disabled
    expect(onBatchMock).not.toHaveBeenCalled();
  });

  it('tool call batch respects cancellation', async () => {
    // WHY: Verify JSON-first mode (tool calls) also respects cancellation
    const onBatchMock = vi.fn();
    const agg = createOllamaAggregator(onBatchMock);

    // Simulate emit_batch tool call
    const toolCallChunk = {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_123',
            function: {
              name: 'emit_batch',
              arguments: '{"ops": [{"op": "state.set", "params": {"scope": "workspace", "key": "test", "value": 42}}]}'
            }
          }]
        }
      }]
    };

    await agg.processDelta(JSON.stringify(toolCallChunk));
    agg.cancel();

    const result = await agg.flush();
    expect(result.cancelled).toBe(true);
    expect(onBatchMock).not.toHaveBeenCalled();
  });
});
