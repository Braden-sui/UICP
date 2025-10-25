import { describe, it, expect, vi } from 'vitest';
import { createOllamaAggregator } from '../../src/lib/uicp/stream';
import type { Batch } from '../../src/lib/uicp/schemas';

const emitBatchToolDelta = (args: string | Record<string, unknown>) =>
  JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_0',
              function: {
                name: 'emit_batch',
                arguments: args,
              },
            },
          ],
        },
      },
    ],
  });

describe('uicp stream aggregator', () => {
  it('applies batch gathered from emit_batch tool call deltas', async () => {
    const onBatch = vi.fn(async (_b: Batch) => {});
    const agg = createOllamaAggregator(onBatch);

    await agg.processDelta(
      emitBatchToolDelta('{"batch":[{"op":"window.create","params":{"title":"One","width":520,"height":320}}'),
    );
    await agg.processDelta(emitBatchToolDelta(']}'));

    await agg.flush();

    expect(onBatch).toHaveBeenCalledTimes(1);
    const batch = onBatch.mock.calls[0]![0] as Batch;
    expect(batch).toHaveLength(1);
    expect(batch[0]?.op).toBe('window.create');
    expect(batch[0]?.params).toMatchObject({ title: 'One' });
  });

  it('parses tool call payloads emitted as objects', async () => {
    const onBatch = vi.fn(async (_b: Batch) => {});
    const agg = createOllamaAggregator(onBatch);

    await agg.processDelta(
      emitBatchToolDelta({
        batch: [{ op: 'window.create', params: { title: 'Obj' } }],
      }),
    );

    await agg.flush();

    expect(onBatch).toHaveBeenCalledTimes(1);
    const batch = onBatch.mock.calls[0]![0] as Batch;
    expect(batch).toHaveLength(1);
    expect(batch[0]?.params).toMatchObject({ title: 'Obj' });
  });

  it('falls back to json channel content when no tool call arrives', async () => {
    const onBatch = vi.fn(async (_b: Batch) => {});
    const agg = createOllamaAggregator(onBatch);

    await agg.processDelta(
      JSON.stringify({
        choices: [
          {
            delta: {
              channel: 'json',
              content: '{"batch":[{"op":"window.create","params":{"title":"FromJson"}}]}',
            },
          },
        ],
      }),
    );

    await agg.flush();

    expect(onBatch).toHaveBeenCalledTimes(1);
    const batch = onBatch.mock.calls[0]![0] as Batch;
    expect(batch).toHaveLength(1);
    expect(batch[0]?.params).toMatchObject({ title: 'FromJson' });
  });

  it('does not apply commentary-only responses', async () => {
    const onBatch = vi.fn(async (_b: Batch) => {});
    const agg = createOllamaAggregator(onBatch);

    await agg.processDelta(
      JSON.stringify({
        choices: [
          {
            delta: {
              channel: 'commentary',
              content: 'Status: still thinking...',
            },
          },
        ],
      }),
    );

    await agg.flush();

    expect(onBatch).not.toHaveBeenCalled();
  });

  it('applies WIL commentary responses when valid commands stream', async () => {
    const onBatch = vi.fn(async (_b: Batch) => {});
    const agg = createOllamaAggregator(onBatch);

    await agg.processDelta(
      JSON.stringify({
        choices: [
          {
            delta: {
              channel: 'commentary',
              content: 'create window title "Legacy" width 520 height 320',
            },
          },
        ],
      }),
    );

    await agg.flush();

    expect(onBatch).toHaveBeenCalledTimes(1);
    const batch = onBatch.mock.calls[0]![0] as Batch;
    expect(batch).toHaveLength(1);
    expect(batch[0]?.op).toBe('window.create');
    if (batch[0]?.op === 'window.create') {
      expect(batch[0]?.params?.title).toBe('Legacy');
    }
  });

  it('surfaces downstream apply failures from tool call batches', async () => {
    const onBatch = vi.fn(async () => ({
      success: false as const,
      applied: 0,
      errors: ['apply failed'],
      skippedDuplicates: 0,
      deniedByPolicy: 0,
      batchId: 'test-batch',
    })) as unknown as (b: Batch) => Promise<import('../../src/lib/uicp/adapters/schemas').ApplyOutcome>;
    const agg = createOllamaAggregator(onBatch);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await agg.processDelta(emitBatchToolDelta('{"batch":[{"op":"window.create","params":{"title":"Boom"}}]}'));
      await expect(agg.flush()).rejects.toThrow('apply failed');
      expect(onBatch).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
