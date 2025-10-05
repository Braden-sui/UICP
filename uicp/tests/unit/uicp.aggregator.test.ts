import { describe, it, expect, vi } from 'vitest';
import { createOllamaAggregator } from '../../src/lib/uicp/stream';
import type { Batch } from '../../src/lib/uicp/schemas';

describe('uicp stream aggregator', () => {
  it('collects commentary deltas and passes parsed batch to onBatch (object with batch)', async () => {
    const onBatch = vi.fn(async (_b: Batch) => {});
    const agg = createOllamaAggregator(onBatch);

    const chunk = {
      choices: [
        {
          delta: {
            channel: 'commentary',
            content: JSON.stringify({ batch: [{ op: 'window.create', params: { title: 'Note' } }] }),
          },
        },
      ],
    };

    await agg.processDelta(JSON.stringify(chunk));
    await agg.flush();

    expect(onBatch).toHaveBeenCalledTimes(1);
    const passed = onBatch.mock.calls[0][0];
    expect(Array.isArray(passed)).toBe(true);
    expect(passed[0].op).toBe('window.create');
  });

  it('extracts first JSON array from noisy buffer', async () => {
    const onBatch = vi.fn(async (_b: Batch) => {});
    const agg = createOllamaAggregator(onBatch);

    const noisy = 'prefix text [ { "op": "window.create", "params": { "title": "Pad" } } ] suffix';
    await agg.processDelta(JSON.stringify({ choices: [{ delta: { channel: 'commentary', content: noisy } }] }));
    await agg.flush();

    expect(onBatch).toHaveBeenCalledTimes(1);
    const batch = onBatch.mock.calls[0][0] as Batch;
    expect(Array.isArray(batch)).toBe(true);
    expect(batch.length).toBe(1);
    expect(batch[0].op).toBe('window.create');
  });
});

