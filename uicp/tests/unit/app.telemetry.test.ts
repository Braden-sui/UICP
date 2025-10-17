import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { telemetryBufferToArray, useAppStore } from '../../src/state/app';
import { emitTelemetryEvent } from '../../src/lib/telemetry';

describe('app telemetry buffer', () => {
  beforeEach(() => {
    useAppStore.getState().clearTelemetry();
  });

  it('keeps newest entries first and enforces capacity', () => {
    const store = useAppStore.getState();
    const capacity = store.telemetryBuffer.capacity;
    const extra = 5;
    const totalInserted = capacity + extra;

    for (let i = 0; i < totalInserted; i += 1) {
      store.upsertTelemetry(`trace-${i}`, { summary: `job ${i}` });
    }

    const entries = telemetryBufferToArray(useAppStore.getState().telemetryBuffer);
    expect(entries).toHaveLength(capacity);
    expect(entries[0]?.traceId).toEqual(`trace-${totalInserted - 1}`);
    expect(entries[entries.length - 1]?.traceId).toEqual(`trace-${Math.max(0, totalInserted - capacity)}`);
  });

  it('updates existing entries in place without duplicating', () => {
    const { upsertTelemetry } = useAppStore.getState();
    upsertTelemetry('trace-update', { summary: 'initial', status: 'planning' });
    upsertTelemetry('trace-update', { status: 'applied', error: 'boom' });

    const [entry] = telemetryBufferToArray(useAppStore.getState().telemetryBuffer, 1);
    expect(entry?.status).toEqual('applied');
    expect(entry?.error).toEqual('boom');
    expect(entry?.summary).toEqual('initial');
  });

  it('supports snapshot limits for consumers', () => {
    const { upsertTelemetry } = useAppStore.getState();
    upsertTelemetry('trace-a', { summary: 'a' });
    upsertTelemetry('trace-b', { summary: 'b' });
    upsertTelemetry('trace-c', { summary: 'c' });

    const limited = telemetryBufferToArray(useAppStore.getState().telemetryBuffer, 2);
    expect(limited).toHaveLength(2);
    expect(limited.map((entry) => entry.traceId)).toEqual(['trace-c', 'trace-b']);
  });
});

describe('trace event log', () => {
  beforeEach(() => {
    useAppStore.getState().clearTraceEvents();
  });

  afterEach(() => {
    useAppStore.getState().clearTraceEvents();
  });

  it('records events by trace id and updates order', () => {
    emitTelemetryEvent('planner_start', { traceId: 'trace-a', data: { intentLength: 5 } });
    emitTelemetryEvent('actor_start', { traceId: 'trace-b', data: { planSummaryLength: 1 } });
    const state = useAppStore.getState();
    expect(state.traceOrder[0]).toBe('trace-b');
    expect(state.traceOrder[1]).toBe('trace-a');
    expect(state.traceEvents['trace-b']?.[0]?.name).toBe('actor_start');
  });

  it('enforces per-trace capacity', () => {
    const max = 85;
    for (let i = 0; i < max; i += 1) {
      emitTelemetryEvent('planner_start', { traceId: 'trace-cap', data: { idx: i } });
    }
    const events = useAppStore.getState().traceEvents['trace-cap'] ?? [];
    expect(events.length).toBeLessThanOrEqual(80);
    expect(events[events.length - 1]?.data?.idx).toBe(max - 1);
  });
});
