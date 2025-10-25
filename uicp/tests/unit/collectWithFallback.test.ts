import { describe, it, expect } from 'vitest';
import { collectWithFallback } from '../../src/lib/llm/collectWithFallback';
import type { StreamEvent } from '../../src/lib/llm/ollama';

async function* mockStream(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const event of events) {
    yield event;
  }
}

describe('collectWithFallback', () => {
  it('accumulates tool arguments even when name arrives after initial deltas', async () => {
    const events: StreamEvent[] = [
      {
        type: 'tool_call',
        index: 0,
        id: 'call_0',
        arguments: '{"batch":',
        isDelta: true,
      },
      {
        type: 'tool_call',
        index: 0,
        id: 'call_0',
        name: 'emit_plan',
        arguments: '[]}',
        isDelta: true,
      },
      { type: 'done' },
    ];

    const result = await collectWithFallback(mockStream(events), 'emit_plan', 5000);

    expect(result.toolResult).not.toBeUndefined();
    expect(result.toolResult?.name).toBe('emit_plan');
    expect(result.toolResult?.args).toEqual({ batch: [] });
  });

  it('returns complete tool call when arguments arrive as an object payload', async () => {
    const events: StreamEvent[] = [
      {
        type: 'tool_call',
        index: 0,
        name: 'emit_plan',
        arguments: { summary: 'Plan', batch: [] },
        isDelta: false,
      },
      { type: 'done' },
    ];

    const result = await collectWithFallback(mockStream(events), 'emit_plan', 5000);

    expect(result.toolResult?.name).toBe('emit_plan');
    expect(result.toolResult?.args).toEqual({ summary: 'Plan', batch: [] });
  });

  it('records text content when no tool call arrives', async () => {
    const jsonPayload = `{"batch":[{"op":"window.create","params":{"title":"Game"}}]}`;
    const events: StreamEvent[] = [
      {
        type: 'content',
        text: jsonPayload,
      },
      { type: 'done' },
    ];

    const result = await collectWithFallback(mockStream(events), 'emit_batch', 5000);

    expect(result.toolResult).toBeUndefined();
    expect(result.textContent).toBe(jsonPayload);
  });
});
