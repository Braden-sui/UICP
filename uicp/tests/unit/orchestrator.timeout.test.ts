import { describe, it, expect, vi, afterEach } from 'vitest';
import type { StreamEvent } from '../../src/lib/llm/ollama';

function createStalledStream(): AsyncIterable<StreamEvent> {
  return {
    [Symbol.asyncIterator]() {
      let closed = false;
      let pending: ((value: IteratorResult<StreamEvent>) => void) | null = null;
      return {
        next() {
          if (closed) {
            return Promise.resolve({ done: true, value: undefined as unknown as StreamEvent });
          }
          return new Promise<IteratorResult<StreamEvent>>((resolve) => {
            pending = resolve;
          });
        },
        return() {
          closed = true;
          if (pending) {
            pending({ done: true, value: undefined as unknown as StreamEvent });
            pending = null;
          }
          return Promise.resolve({ done: true, value: undefined as unknown as StreamEvent });
        },
      };
    },
  };
}

vi.mock('../../src/lib/llm/provider', () => {
  const stream = createStalledStream();
  return {
    getPlannerClient: () => ({
      streamIntent: () => stream,
    }),
    getActorClient: () => ({
      streamPlan: () => stream,
    }),
  };
});

import { planWithDeepSeek } from '../../src/lib/llm/orchestrator';

describe('planWithDeepSeek timeout handling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects when the planner stream stalls beyond the timeout window', async () => {
    vi.useFakeTimers();
    const promise = planWithDeepSeek('stalled intent', { timeoutMs: 10 });
    const expectation = expect(promise).rejects.toThrow(/timeout/i);
    await vi.runAllTimersAsync();
    await expectation;
  });
});
