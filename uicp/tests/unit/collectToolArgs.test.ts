import { describe, it, expect } from 'vitest';
import { collectToolArgs, collectAllToolCalls } from '../../src/lib/llm/collectToolArgs';
import type { StreamEvent } from '../../src/lib/llm/ollama';

async function* mockStream(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const event of events) {
    yield event;
  }
}

describe('collectToolArgs', () => {
  it('collects complete tool call arguments in delta mode', async () => {
    const events: StreamEvent[] = [
      { type: 'tool_call', index: 0, name: 'emit_plan', arguments: '{ "summary": "Test', isDelta: true },
      { type: 'tool_call', index: 0, arguments: ' plan", "batch": []', isDelta: true },
      { type: 'tool_call', index: 0, arguments: ' }', isDelta: true },
      { type: 'done' },
    ];

    const result = await collectToolArgs(mockStream(events), 'emit_plan', 5000);

    expect(result).not.toBeNull();
    expect(result?.name).toBe('emit_plan');
    expect(result?.args).toEqual({ summary: 'Test plan', batch: [] });
  });

  it('collects complete tool call with single non-delta object', async () => {
    const events: StreamEvent[] = [
      {
        type: 'tool_call',
        index: 0,
        id: 'call_123',
        name: 'emit_batch',
        arguments: { batch: [{ op: 'window.create', params: { title: 'Test' } }] },
        isDelta: false,
      },
      { type: 'done' },
    ];

    const result = await collectToolArgs(mockStream(events), 'emit_batch', 5000);

    expect(result).not.toBeNull();
    expect(result?.id).toBe('call_123');
    expect(result?.name).toBe('emit_batch');
    expect(result?.args).toEqual({ batch: [{ op: 'window.create', params: { title: 'Test' } }] });
  });

  it('returns null when no matching tool name found', async () => {
    const events: StreamEvent[] = [
      { type: 'tool_call', index: 0, name: 'other_tool', arguments: '{}', isDelta: true },
      { type: 'done' },
    ];

    const result = await collectToolArgs(mockStream(events), 'emit_plan', 5000);

    expect(result).toBeNull();
  });

  it('throws on malformed JSON in delta accumulation', async () => {
    const events: StreamEvent[] = [
      { type: 'tool_call', index: 0, name: 'emit_plan', arguments: '{ "summary": ', isDelta: true },
      { type: 'tool_call', index: 0, arguments: 'INVALID', isDelta: true },
      { type: 'done' },
    ];

    await expect(collectToolArgs(mockStream(events), 'emit_plan', 5000)).rejects.toThrow('E-UICP-0101');
  });

  it('throws on timeout', async () => {
    async function* slowStream(): AsyncIterable<StreamEvent> {
      await new Promise((resolve) => setTimeout(resolve, 200));
      yield { type: 'content', text: 'slow' };
    }

    await expect(collectToolArgs(slowStream(), 'emit_plan', 100)).rejects.toThrow('E-UICP-0100');
  });

  it('handles multiple tool calls and returns first matching', async () => {
    const events: StreamEvent[] = [
      { type: 'tool_call', index: 0, name: 'other_tool', arguments: '{"a": 1}', isDelta: true },
      { type: 'tool_call', index: 1, name: 'emit_plan', arguments: '{"summary": "Plan"}', isDelta: true },
      { type: 'done' },
    ];

    const result = await collectToolArgs(mockStream(events), 'emit_plan', 5000);

    expect(result).not.toBeNull();
    expect(result?.index).toBe(1);
    expect(result?.name).toBe('emit_plan');
    expect(result?.args).toEqual({ summary: 'Plan' });
  });
});

describe('collectAllToolCalls', () => {
  it('collects all tool calls from stream', async () => {
    const events: StreamEvent[] = [
      { type: 'tool_call', index: 0, name: 'tool_a', arguments: '{"a": 1}', isDelta: true },
      { type: 'tool_call', index: 1, name: 'tool_b', arguments: '{"b": 2}', isDelta: true },
      { type: 'done' },
    ];

    const results = await collectAllToolCalls(mockStream(events), 5000);

    expect(results).toHaveLength(2);
    expect(results[0].name).toBe('tool_a');
    expect(results[0].args).toEqual({ a: 1 });
    expect(results[1].name).toBe('tool_b');
    expect(results[1].args).toEqual({ b: 2 });
  });

  it('handles mixed delta and non-delta modes', async () => {
    const events: StreamEvent[] = [
      { type: 'tool_call', index: 0, name: 'delta_tool', arguments: '{"x":', isDelta: true },
      { type: 'tool_call', index: 0, arguments: ' 1}', isDelta: true },
      { type: 'tool_call', index: 1, name: 'complete_tool', arguments: { y: 2 }, isDelta: false },
      { type: 'done' },
    ];

    const results = await collectAllToolCalls(mockStream(events), 5000);

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.name === 'delta_tool')?.args).toEqual({ x: 1 });
    expect(results.find((r) => r.name === 'complete_tool')?.args).toEqual({ y: 2 });
  });

  it('skips tool calls with empty buffers', async () => {
    const events: StreamEvent[] = [
      { type: 'tool_call', index: 0, name: 'empty', arguments: '', isDelta: true },
      { type: 'tool_call', index: 1, name: 'valid', arguments: '{"ok": true}', isDelta: true },
      { type: 'done' },
    ];

    const results = await collectAllToolCalls(mockStream(events), 5000);

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('valid');
  });
});
