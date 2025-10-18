import { describe, it, expect, vi } from 'vitest';
import { createOllamaAggregator } from '../../src/lib/uicp/stream';
import type { Batch } from '../../src/lib/uicp/schemas';

describe('uicp stream aggregator', () => {
  it('collects commentary deltas and passes parsed WIL batch to onBatch', async () => {
    const onBatch = vi.fn(async (_b: Batch) => {});
    const agg = createOllamaAggregator(onBatch);

    const chunk = { choices: [{ delta: { channel: 'commentary', content: 'create window title "Note" width 520 height 320' } }] };

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

    // Final includes authoritative WIL lines (two ops)
    const wil = 'create window title "Final Wins" width 520 height 320\ncreate window title "Another" width 520 height 320';
    await agg.processDelta(JSON.stringify({ choices: [{ delta: { channel: 'final', content: wil } }] }));

    await agg.flush();

    expect(onBatch).toHaveBeenCalledTimes(1);
    const batch = onBatch.mock.calls[0][0] as Batch;
    expect(Array.isArray(batch)).toBe(true);
    expect(batch.length).toBe(2);
    expect(batch[0].op).toBe('window.create');
  });

  it('ignores tool_call and still processes WIL lines', async () => {
    const onBatch = vi.fn(async (_b: Batch) => {});
    const agg = createOllamaAggregator(onBatch);

    // Emit a tool_call and a commentary WIL line; aggregator should use the WIL
    await agg.processDelta(JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { name: 'emit_batch', arguments: '{}' } }] } }] }));
    await agg.processDelta(JSON.stringify({ choices: [{ delta: { channel: 'commentary', content: 'create window title "Via Tool" width 520 height 320' } }] }));
    await agg.flush();

    expect(onBatch).toHaveBeenCalledTimes(1);
    const batch = onBatch.mock.calls[0][0] as Batch;
    expect(Array.isArray(batch)).toBe(true);
    expect(batch[0].op).toBe('window.create');
    expect((batch[0] as any).params.title).toBe('Via Tool');
  });

  it('accumulates text across multiple deltas', async () => {
    const onBatch = vi.fn(async (_b: Batch) => {});
    const agg = createOllamaAggregator(onBatch);

    await agg.processDelta(JSON.stringify({ choices: [{ delta: { channel: 'commentary', content: 'create window title "Mer' } }] }));
    await agg.processDelta(JSON.stringify({ choices: [{ delta: { channel: 'commentary', content: 'ged" width 520 height 320' } }] }));
    await agg.flush();

    expect(onBatch).toHaveBeenCalledTimes(1);
    const batch = onBatch.mock.calls[0][0] as Batch;
    expect(Array.isArray(batch)).toBe(true);
    expect(batch.length).toBe(1);
    expect(batch[0].op).toBe('window.create');
    expect(batch[0].params).toEqual({ title: 'Merged', width: 520, height: 320 });
  });

  it('extracts fenced WIL from commentary noise', async () => {
    const onBatch = vi.fn(async (_b: Batch) => {});
    const agg = createOllamaAggregator(onBatch);

    const noisy = 'status: working... ```\ncreate window title "Valid" width 520 height 320\n``` trailing text';

    await agg.processDelta(
      JSON.stringify({ choices: [{ delta: { channel: 'commentary', content: noisy } }] }),
    );

    await agg.flush();

    expect(onBatch).toHaveBeenCalledTimes(1);
    const batch = onBatch.mock.calls[0][0] as Batch;
    expect(batch[0].op).toBe('window.create');
    expect((batch[0] as any).params.title).toBe('Valid');
  });

  it('extracts WIL lines from buffer', async () => {
    const onBatch = vi.fn(async (_b: Batch) => {});
    const agg = createOllamaAggregator(onBatch);

    const text = 'create window title "Pad" width 520 height 320';
    await agg.processDelta(JSON.stringify({ choices: [{ delta: { channel: 'commentary', content: text } }] }));
    await agg.flush();

    expect(onBatch).toHaveBeenCalledTimes(1);
    const batch = onBatch.mock.calls[0][0] as Batch;
    expect(Array.isArray(batch)).toBe(true);
    expect(batch.length).toBe(1);
    expect(batch[0].op).toBe('window.create');
  });

  it('throws when downstream batch application reports failure', async () => {
    const onBatch = vi.fn(async () => ({ success: false, applied: 0, errors: ['apply failed'], skippedDuplicates: 0, deniedByPolicy: 0, batchId: '' }));
    const agg = createOllamaAggregator(onBatch);
    const payload = 'create window title "Boom" width 520 height 320';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await agg.processDelta(JSON.stringify({ choices: [{ delta: { channel: 'commentary', content: payload } }] }));
      await expect(agg.flush()).rejects.toThrow('apply failed');
      expect(onBatch).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
