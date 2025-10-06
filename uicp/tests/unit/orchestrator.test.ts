import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StreamEvent } from '../../src/lib/llm/ollama';

// Mock provider to drive orchestrator with deterministic streams
vi.mock('../../src/lib/llm/provider', () => {
  return {
    getPlannerClient: () => ({
      streamIntent: (_intent: string) => makeStream([
        { type: 'content', channel: 'commentary', text: '```json' },
        {
          type: 'content',
          channel: 'commentary',
          text: JSON.stringify({ summary: 'Create notepad', batch: [{ op: 'window.create', params: { title: 'Notepad' } }] }),
        },
        { type: 'content', channel: 'commentary', text: '```' },
        { type: 'done' },
      ]),
    }),
    getActorClient: () => ({
      streamPlan: (_planJson: string) => makeStream([
        { type: 'content', channel: 'commentary', text: '```json' },
        {
          type: 'content',
          channel: 'commentary',
          text: JSON.stringify({ batch: [{ op: 'window.create', params: { title: 'Notepad' } }] }),
        },
        { type: 'content', channel: 'commentary', text: '```' },
        { type: 'done' },
      ]),
    }),
  };
});

// Helper: turns an array of events into an AsyncIterable
function makeStream(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const ev of events) yield ev;
    },
  };
}

// Import under test AFTER mocks
import { planWithDeepSeek, actWithGui, runIntent } from '../../src/lib/llm/orchestrator';

describe('orchestrator integration', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('parses fenced JSON from planner stream', async () => {
    const plan = await planWithDeepSeek('make a notepad');
    expect(plan.summary).toMatch(/notepad/i);
    expect(Array.isArray(plan.batch)).toBe(true);
    expect(plan.batch[0].op).toBe('window.create');
  });

  it('extracts batch array from commentary buffer with surrounding noise', async () => {
    const plan = await planWithDeepSeek('make a notepad');
    const batch = await actWithGui(plan);
    expect(Array.isArray(batch)).toBe(true);
    expect(batch.length).toBe(1);
    expect(batch[0].op).toBe('window.create');
  });

  it('runs end-to-end and returns plan + batch with stamped metadata', async () => {
    const { plan, batch, traceId, timings } = await runIntent('make a notepad', false);
    expect(plan.summary).toBeDefined();
    expect(batch.length).toBeGreaterThan(0);
    expect(batch.every((env) => typeof env.idempotencyKey === 'string' && env.idempotencyKey.length > 0)).toBe(true);
    const traceIds = new Set(batch.map((env) => env.traceId));
    const txnIds = new Set(batch.map((env) => env.txnId));
    expect(traceIds.size).toBe(1);
    expect(txnIds.size).toBe(1);
    expect(typeof traceId).toBe('string');
    expect(traceId.length).toBeGreaterThan(0);
    expect(timings.planMs).toBeGreaterThanOrEqual(0);
    expect(timings.actMs).toBeGreaterThanOrEqual(0);
  });

  it('emits phase updates to observers', async () => {
    const phases: Array<{ phase: string; planMs?: number }> = [];
    await runIntent('make a notepad', false, {
      onPhaseChange: (detail) => {
        phases.push(detail);
      },
    });
    expect(phases.length).toBeGreaterThanOrEqual(2);
    expect(phases[0]?.phase).toBe('planning');
    expect(phases[1]?.phase).toBe('acting');
    expect(typeof phases[1]?.planMs).toBe('number');
    expect((phases[1]?.planMs ?? 0)).toBeGreaterThanOrEqual(0);
  });
});
