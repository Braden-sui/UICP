import { describe, it, expect, vi } from 'vitest';
import type { StreamEvent } from '../../src/lib/llm/llm.stream';

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
          // Return empty text quickly via a return event to trigger planner_fallback
          streamIntent: (_intent: string) => makeStream([{ type: 'return', channel: 'final', result: '' }, { type: 'done' }]),
        }),
        getActorClient: () => ({
          streamPlan: (_planJson: string) =>
            makeStream([
              {
                type: 'tool_call',
                index: 0,
                name: 'emit_batch',
                arguments: { batch: [{ op: 'window.create', params: { title: 'From Actor Only' } }] },
                isDelta: false,
              },
              { type: 'done' },
            ]),
        }),
      };
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { runIntent } = await import('../../src/lib/llm/orchestrator');
      const res = await runIntent('make a notepad', false);
      expect(res.notice).toBe('planner_fallback');
      expect(res.batch.length).toBeGreaterThan(0);
      expect(res.batch.every((env) => env.traceId && env.txnId && env.idempotencyKey)).toBe(true);
      expect(typeof res.traceId).toBe('string');
      expect(res.timings.planMs).toBeGreaterThanOrEqual(0);
      expect(res.timings.actMs).toBeGreaterThanOrEqual(0);
      expect(res.failures?.planner).toBeDefined();
      expect(Array.isArray(res.plan.risks)).toBe(true);
      expect(res.plan.risks?.some((risk) => risk.startsWith('planner_error:'))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  }, 30000);

  it('routes nop back to planner (no batch)', async () => {
    vi.resetModules();
    vi.doMock('../../src/lib/llm/provider', () => {
      return {
        getPlannerClient: () => ({
          streamIntent: (_intent: string) =>
            makeStream([
              { type: 'content', channel: 'commentary', text: 'Summary: ok' },
              { type: 'done' },
            ]),
        }),
        getActorClient: () => ({
          streamPlan: (_planJson: string) =>
            makeStream([
              { type: 'content', channel: 'commentary', text: 'nop: invalid WIL line' },
              { type: 'done' },
            ]),
        }),
      };
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { runIntent } = await import('../../src/lib/llm/orchestrator');
      const res = await runIntent('anything', false);
      expect(res.notice).toBe('planner_fallback');
      expect(Array.isArray(res.batch)).toBe(true);
      expect(res.batch.length).toBe(0);
      expect(typeof res.traceId).toBe('string');
      expect(res.timings.planMs).toBeGreaterThanOrEqual(0);
      expect(res.timings.actMs).toBeGreaterThanOrEqual(0);
      expect(res.failures?.actor?.toLowerCase()).toContain('missing emit_batch');
    } finally {
      errorSpy.mockRestore();
    }
  }, 30000);
});
