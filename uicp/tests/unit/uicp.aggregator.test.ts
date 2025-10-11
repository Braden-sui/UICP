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

  it('prefers final channel content over commentary on flush', async () => {
    const onBatch = vi.fn(async (_b: Batch) => {});
    const agg = createOllamaAggregator(onBatch);

    // Commentary carries some distracting text
    await agg.processDelta(
      JSON.stringify({ choices: [{ delta: { channel: 'commentary', content: 'noise ' } }] }),
    );

    // Final includes the authoritative JSON batch
    const payload = [
      { op: 'window.create', params: { title: 'Final Wins' } },
      { op: 'window.focus', params: { id: 'w1' } },
    ];
    await agg.processDelta(
      JSON.stringify({ choices: [{ delta: { channel: 'final', content: JSON.stringify(payload) } }] }),
    );

    await agg.flush();

    expect(onBatch).toHaveBeenCalledTimes(1);
    const batch = onBatch.mock.calls[0][0] as Batch;
    expect(Array.isArray(batch)).toBe(true);
    expect(batch.length).toBe(2);
    expect(batch[0].op).toBe('window.create');
  });

  it('uses tool_call arguments when present', async () => {
    const onBatch = vi.fn(async (_b: Batch) => {});
    const agg = createOllamaAggregator(onBatch);

    const toolCallChunk = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                id: 'tool-0',
                function: {
                  name: 'emit_batch',
                  arguments: JSON.stringify({
                    batch: [{ op: 'window.create', params: { title: 'Via Tool' } }],
                  }),
                },
              },
            ],
          },
        },
      ],
    };

    await agg.processDelta(JSON.stringify(toolCallChunk));
    await agg.flush();

    expect(onBatch).toHaveBeenCalledTimes(1);
    const batch = onBatch.mock.calls[0][0] as Batch;
    expect(Array.isArray(batch)).toBe(true);
    expect(batch[0].op).toBe('window.create');
    expect((batch[0] as any).params.title).toBe('Via Tool');
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

  it('throws when downstream batch application reports failure', async () => {
    const onBatch = vi.fn(async () => ({ success: false, applied: 0, errors: ['apply failed'] }));
    const agg = createOllamaAggregator(onBatch);
    const payload = [{ op: 'window.create', params: { title: 'Boom' } }];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await agg.processDelta(JSON.stringify({ choices: [{ delta: { channel: 'commentary', content: JSON.stringify(payload) } }] }));
      await expect(agg.flush()).rejects.toThrow('apply failed');
      expect(onBatch).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
