import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OssHarmonyAdapter } from '../../src/lib/llm/adapters/oss-harmony-adapter';
import type { StreamEvent } from '../../src/lib/llm/ollama';

const encoder = new TextEncoder();

const toStream = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

describe('OssHarmonyAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('streams harmony frames, filters analysis, and emits final return', async () => {
    const analysis = '<|start|><|channel|>analysis<|message|>thinking<|end|>';
    const commentary = '<|start|><|channel|>commentary<|message|>rendering UI<|end|>';
    const toolCall = '<|start|><|channel|>commentary<|call|>window.create {"title":"Sheet"}<|end|>';
    const final = '<|start|><|channel|>final<|return|>{"batch":[{"op":"noop"}]}<|end|>';

    const frames = [
      `data: ${JSON.stringify({ delta: analysis })}\n\n`,
      `data: ${JSON.stringify({ delta: commentary })}\n\n`,
      `data: ${JSON.stringify({ delta: toolCall })}\n\n`,
      `data: ${JSON.stringify({ delta: final })}\n\n`,
      'data: [DONE]\n\n',
    ];

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: toStream(frames),
    }));

    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OssHarmonyAdapter({
      endpoint: 'https://example.com/chat',
      apiKey: 'secret-key',
    });

    const events: StreamEvent[] = [];
    for await (const event of adapter.chat({ messages: [], tools: [] })) {
      events.push(event);
    }

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/chat',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-key',
          'Content-Type': 'application/json',
        }),
      }),
    );

    const contentEvents = events.filter((ev): ev is Extract<StreamEvent, { type: 'content' }> => ev.type === 'content');
    expect(contentEvents.length).toBeGreaterThanOrEqual(1);
    expect(contentEvents.some((ev) => ev.channel === 'commentary' && ev.text.includes('rendering UI'))).toBe(true);
    expect(contentEvents.every((ev) => ev.channel !== 'analysis')).toBe(true);

    const tool = events.find((ev): ev is Extract<StreamEvent, { type: 'tool_call' }> => ev.type === 'tool_call');
    expect(tool).toBeDefined();
    expect(tool.name).toBe('window.create');
    expect(tool.arguments).toBe(JSON.stringify({ title: 'Sheet' }));
    expect(tool.isDelta).toBe(false);

    const finalEvent = events.find((ev): ev is Extract<StreamEvent, { type: 'return' }> => ev.type === 'return');
    expect(finalEvent).toBeDefined();
    expect(finalEvent.channel).toBe('final');
    expect(finalEvent.result).toEqual({ batch: [{ op: 'noop' }] });

    const lastEvent = events.at(-1);
    expect(lastEvent?.type).toBe('done');
  });
});
