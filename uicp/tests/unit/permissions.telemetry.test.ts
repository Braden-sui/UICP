import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkPermission } from '../../src/lib/permissions/PermissionManager';
import type { Envelope } from '../../src/lib/uicp/schemas';
import { useAppStore } from '../../src/state/app';

describe('permissions telemetry events', () => {
  beforeEach(() => {
    useAppStore.getState().clearTraceEvents();
  });

  afterEach(() => {
    useAppStore.getState().clearTraceEvents();
  });

  it('emits prompt and decision events for api.call', async () => {
    const traceId = 'trace-perm';
    const envelope = {
      op: 'api.call',
      params: { method: 'GET', url: 'https://example.com/api' },
      traceId,
    } as Envelope;

    const decision = await checkPermission(envelope, async () => ({
      decision: 'allow',
      duration: 'once',
    }));

    expect(decision).toBe('allow');
    const events = useAppStore.getState().traceEvents[traceId] ?? [];
    const names = events.map((event) => event.name);
    expect(names).toContain('permissions_prompt');
    expect(names).toContain('permissions_allow');
  });
});
