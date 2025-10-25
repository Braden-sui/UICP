import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StreamEvent } from '../../src/lib/llm/ollama';
import * as Telemetry from '../../src/lib/telemetry';

const plannerBase: StreamEvent[] = [
  { type: 'content', channel: 'commentary', text: 'Summary: Create notepad' },
  { type: 'content', channel: 'commentary', text: 'Steps:' },
  { type: 'content', channel: 'commentary', text: '- Create a window titled "Notepad"' },
  { type: 'done' },
];

const actorBase: StreamEvent[] = [
  { type: 'content', channel: 'commentary', text: 'create window title "Notepad" width 520 height 320' },
  { type: 'done' },
];

let plannerEvents: StreamEvent[] = plannerBase;
let actorEvents: StreamEvent[] = actorBase;

// Mock provider to drive orchestrator with deterministic streams
vi.mock('../../src/lib/llm/provider', () => {
  return {
    getPlannerClient: () => ({
      streamIntent: (_intent: string) => makeStream(plannerEvents),
    }),
    getActorClient: () => ({
      streamPlan: (_planJson: string) => makeStream(actorEvents),
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
import { planWithDeepSeek, actWithGui, runIntent, planWithProfile, actWithProfile } from '../../src/lib/llm/orchestrator';

describe('orchestrator integration', () => {
  beforeEach(() => {
    vi.useRealTimers();
    plannerEvents = [...plannerBase];
    actorEvents = [...actorBase];
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('parses planner outline text (plain sections)', async () => {
    const plan = await planWithDeepSeek('make a notepad');
    expect(plan.summary).toMatch(/notepad/i);
    expect(Array.isArray(plan.batch)).toBe(true);
    expect(plan.batch.length).toBe(0);
  });

  it('extracts WIL commands from text and applies order', async () => {
    const plan = await planWithDeepSeek('make a notepad');
    const batch = await actWithGui(plan);
    expect(Array.isArray(batch)).toBe(true);
    expect(batch.length).toBeGreaterThanOrEqual(1);
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
    const phases: Array<{ phase: string; planMs?: number; traceId: string }> = [];
    await runIntent('make a notepad', false, {
      onPhaseChange: (detail) => {
        phases.push(detail);
      },
    });
    expect(phases.length).toBeGreaterThanOrEqual(2);
    const planning = phases[0];
    const acting = phases[1];
    expect(planning?.phase).toBe('planning');
    expect(typeof planning?.traceId).toBe('string');
    expect((planning?.traceId ?? '').length).toBeGreaterThan(0);
    expect(acting?.phase).toBe('acting');
    expect(acting?.planMs).toBeGreaterThanOrEqual(0);
    expect(acting?.traceId).toBe(planning?.traceId);
  });

  it('emits telemetry around planner and actor phases', async () => {
    const telemetrySpy = vi.spyOn(Telemetry, 'emitTelemetryEvent');

    await runIntent('collect telemetry', false);

    const events = telemetrySpy.mock.calls.map(([name, payload]) => ({ name, payload }));

    const plannerStart = events.find((e) => e.name === 'planner_start' && e.payload?.data?.phase === 'plan');
    const plannerFinish = events.find((e) => e.name === 'planner_finish' && e.payload?.data?.phase === 'plan');
    const actorStart = events.find((e) => e.name === 'actor_start');
    const actorFinish = events.find((e) => e.name === 'actor_finish');

    expect(plannerStart).toBeDefined();
    expect(plannerStart?.payload?.traceId).toBeDefined();
    expect(plannerStart?.payload?.data?.intentLength).toBeGreaterThan(0);

    expect(plannerFinish).toBeDefined();
    expect(plannerFinish?.payload?.durationMs).toBeGreaterThanOrEqual(0);
    expect(plannerFinish?.payload?.data?.summary).toMatch(/create notepad/i);

    expect(actorStart).toBeDefined();
    expect(actorStart?.payload?.traceId).toBe(plannerStart?.payload?.traceId);
    expect(actorStart?.payload?.data?.plannerFallback).toBe(false);

    expect(actorFinish).toBeDefined();
    expect(actorFinish?.payload?.traceId).toBe(plannerStart?.payload?.traceId);
    expect(actorFinish?.payload?.data?.batchSize).toBeGreaterThan(0);
  });

  it('consumes return events emitted by the streaming transport', async () => {
    plannerEvents = [
      { type: 'return', channel: 'final', result: 'Summary: Return plan' },
      { type: 'done' },
    ];
    actorEvents = [
      { type: 'return', channel: 'final', result: 'create window title "FromReturn" width 520 height 320' },
      { type: 'done' },
    ];

    const { plan } = await planWithProfile('unused', { profileKey: 'deepseek' });
    expect(plan.summary).toBe('Return plan');

    const { batch } = await actWithProfile(plan, { profileKey: 'qwen' });
    expect(Array.isArray(batch)).toBe(true);
    expect(batch[0]?.params).toMatchObject({ title: 'FromReturn' });
  });
});
