import { describe, it, expect, vi } from 'vitest';
import type { StreamEvent } from '../../src/lib/llm/ollama';

// Helpers
function makeStream(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const ev of events) yield ev;
    },
  };
}

describe('orchestrator fallbacks', () => {
  it('uses actor-only fallback when planner fails', async () => {
    vi.resetModules();
    vi.doMock('../../src/lib/llm/provider', () => {
      return {
        getPlannerClient: () => ({
          streamIntent: (_intent: string) => makeStream([]),
        }),
        getActorClient: () => ({
          streamPlan: (_planJson: string) =>
            makeStream([
              { type: 'content', channel: 'commentary', text: '```json' },
              {
                type: 'content',
                channel: 'commentary',
                text: JSON.stringify({ batch: [{ op: 'window.create', params: { title: 'From Actor Only' } }] }),
              },
              { type: 'content', channel: 'commentary', text: '```' },
              { type: 'done' },
            ]),
        }),
      };
    });
    const { runIntent } = await import('../../src/lib/llm/orchestrator');
    const res = await runIntent('make a notepad', false);
    expect(res.notice).toBe('planner_fallback');
    expect(res.batch.length).toBeGreaterThan(0);
    expect(res.batch.every((env) => env.traceId && env.txnId && env.idempotencyKey)).toBe(true);
  });

  it('returns safe error window when actor fails', async () => {
    vi.resetModules();
    vi.doMock('../../src/lib/llm/provider', () => {
      return {
        getPlannerClient: () => ({
          streamIntent: (_intent: string) =>
            makeStream([
              { type: 'content', channel: 'commentary', text: '```json' },
              { type: 'content', channel: 'commentary', text: JSON.stringify({ summary: 'ok', batch: [] }) },
              { type: 'content', channel: 'commentary', text: '```' },
              { type: 'done' },
            ]),
        }),
        getActorClient: () => ({
          streamPlan: (_planJson: string) => makeStream([]),
        }),
      };
    });
    const { runIntent } = await import('../../src/lib/llm/orchestrator');
    const res = await runIntent('anything', false);
    expect(res.notice).toBe('actor_fallback');
    // expect first op to be window.create with Action Failed title
    expect(res.batch[0].op).toBe('window.create');
    expect(res.batch.every((env) => env.traceId && env.txnId && env.idempotencyKey)).toBe(true);
  });
});
