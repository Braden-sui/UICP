import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../flags', async () => {
  return {
    isProviderRouterV1Enabled: () => true,
  };
});

const emitted: Array<{ name: string; traceId?: string; data?: Record<string, unknown> }> = [];
vi.mock('../telemetry', async () => {
  return {
    emitTelemetryEvent: (name: string, payload: { traceId?: string; data?: Record<string, unknown> }) => {
      emitted.push({ name, traceId: payload?.traceId, data: payload?.data });
    },
  };
});

// Minimal async iterable of a single done event
const doneIterable: AsyncIterable<{ type: 'done' }> = {
  [Symbol.asyncIterator]() {
    let done = false;
    return {
      async next() {
        if (done) return { value: undefined as any, done: true };
        done = true;
        return { value: { type: 'done' }, done: false } as any;
      },
    };
  },
};

vi.mock('../router', async () => {
  return {
    route: () => doneIterable as any,
  };
});

import { getPlannerClient, getActorClient } from '../provider';

describe('provider router telemetry', () => {
  beforeEach(() => {
    emitted.length = 0;
  });

  it('emits provider_decision for planner when router is enabled', async () => {
    const client = getPlannerClient();
    const stream = client.streamIntent('hello', {
      model: 'gpt-oss:120b',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      meta: { traceId: 't-planner' } as any,
    } as any);
    // Drain iterable
    for await (const _ of stream) {
      void _;
    }
    const evt = emitted.find((e) => e.name === 'provider_decision');
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
      meta: { traceId: 't-actor' } as any,
    } as any);
    for await (const _ of stream) {
      void _;
    }
    const idx = (() => {
      let i = emitted.length - 1;
      for (; i >= 0; i--) {
        if (emitted[i] && emitted[i]!.name === 'provider_decision') return i;
      }
      return -1;
    })();
    const evt = idx >= 0 ? emitted[idx] : undefined;
    expect(evt?.traceId).toBe('t-actor');
    expect(evt?.data?.role).toBe('actor');
    expect(evt?.data?.provider).toBe('openai');
  });
});
