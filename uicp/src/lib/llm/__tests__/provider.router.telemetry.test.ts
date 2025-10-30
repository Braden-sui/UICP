import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks to satisfy Vitest's module mocking order
const mocks = vi.hoisted(() => {
  const emitted: Array<{ name: string; traceId?: string; data?: Record<string, unknown> }> = [];
  return {
    emitted,
    emitTelemetryEvent: vi.fn((name: string, payload: { traceId?: string; data?: Record<string, unknown> }) => {
      emitted.push({ name, traceId: payload?.traceId, data: payload?.data });
    }),
  };
});

vi.mock('../flags', async () => {
  return {
    isProviderRouterV1Enabled: () => true,
  };
});

vi.mock('../../telemetry', () => ({ emitTelemetryEvent: mocks.emitTelemetryEvent }));
vi.mock('../telemetry', () => ({ emitTelemetryEvent: mocks.emitTelemetryEvent }));

// Minimal async iterable of a single done event
const doneIterable: AsyncIterable<{ type: 'done' }> = {
  [Symbol.asyncIterator]() {
    let done = false;
    return {
      async next() {
        if (done) return { value: undefined, done: true };
        done = true;
        return { value: { type: 'done' }, done: false };
      },
    };
  },
};

vi.mock('../router', async () => {
  return {
    route: () => doneIterable,
  };
});

import { getPlannerClient, getActorClient } from '../provider';

describe('provider router telemetry', () => {
  beforeEach(() => {
    mocks.emitted.length = 0;
  });

  it('emits provider_decision for planner when router is enabled', async () => {
    const client = getPlannerClient();
    const stream = client.streamIntent('hello', {
      model: 'gpt-oss:120b',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      meta: { traceId: 't-planner' },
    });
    // Drain iterable
    for await (const _ of stream) {
      void _;
    }
    const evt = mocks.emitted.find((e) => e.name === 'provider_decision');
    expect(evt?.traceId).toBe('t-planner');
    expect(evt?.data?.role).toBe('planner');
    expect(evt?.data?.provider).toBe('openai');
  });

  it('emits provider_decision for actor when router is enabled', async () => {
    const client = getActorClient();
    const stream = client.streamPlan('{"summary":"test","batch":[]}', {
      model: 'gpt-oss:120b',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      meta: { traceId: 't-actor' },
    });
    for await (const _ of stream) {
      void _;
    }
    const idx = (() => {
      let i = mocks.emitted.length - 1;
      for (; i >= 0; i--) {
        if (mocks.emitted[i] && mocks.emitted[i]!.name === 'provider_decision') return i;
      }
      return -1;
    })();
    const evt = idx >= 0 ? mocks.emitted[idx] : undefined;
    expect(evt?.traceId).toBe('t-actor');
    expect(evt?.data?.role).toBe('actor');
    expect(evt?.data?.provider).toBe('openai');
  });
});
