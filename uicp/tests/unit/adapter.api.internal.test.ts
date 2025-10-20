import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { routeApiCall } from '../../src/lib/uicp/adapters/adapter.api';
import type { Envelope, OperationParamMap } from '../../src/lib/uicp/adapters/schemas';
import type { StructuredClarifierBody } from '../../src/lib/uicp/adapters/adapter.clarifier';
import type { CommandResult } from '../../src/lib/uicp/adapters/adapter.commands';
import * as BridgeGlobals from '../../src/lib/bridge/globals';
import type { JobSpec } from '../../src/compute/types';

const makeEnvelope = (overrides?: Partial<Envelope>): Envelope =>
  ({
    op: 'api.call',
    params: { url: 'uicp://intent' } as OperationParamMap['api.call'],
    ...overrides,
  } as Envelope);

describe('routeApiCall internal schemes', () => {
  let computeBridgeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    computeBridgeSpy = vi.spyOn(BridgeGlobals, 'getComputeBridge');
  });

  afterEach(() => {
    computeBridgeSpy.mockRestore();
  });

  const clarifierMock = () => ({ success: true as const, value: 'clarified' });

  it('routes compute.call to the compute bridge and preserves payload fields', async () => {
    const renderClarifier = vi.fn<(body: StructuredClarifierBody, command: Envelope) => CommandResult<string>>(clarifierMock);
    const computeInvoke = vi.fn(async (_spec: JobSpec) => {});
    computeBridgeSpy.mockReturnValue(computeInvoke);

    const params: OperationParamMap['api.call'] = {
      method: 'POST',
      url: 'uicp://compute.call',
      idempotencyKey: 'job-key-001',
      body: {
        jobId: '00000000-0000-4000-8000-000000000abc',
        task: 'csv.parse@1.2.0',
        input: { rows: [] },
      },
    };

    const result = await routeApiCall(params, makeEnvelope(), {}, renderClarifier);

    expect(result).toEqual({ success: true, value: 'job-key-001' });
    expect(computeInvoke).toHaveBeenCalledTimes(1);
    const spec = computeInvoke.mock.calls[0]?.[0];
    expect(spec).toMatchObject({
      jobId: '00000000-0000-4000-8000-000000000abc',
      task: 'csv.parse@1.2.0',
      workspaceId: 'default',
      input: { rows: [] },
      provenance: { envHash: 'adapter.api@v2' },
    });
    expect(renderClarifier).not.toHaveBeenCalled();
  });

  it('surfaces an error when compute payload is incomplete', async () => {
    const renderClarifier = vi.fn<(body: StructuredClarifierBody, command: Envelope) => CommandResult<string>>(clarifierMock);
    const computeInvoke = vi.fn(async () => {});
    computeBridgeSpy.mockReturnValue(computeInvoke);

    const params = {
      method: 'POST',
      url: 'uicp://compute.call',
      body: { task: 'csv.parse@1.2.0' },
    } as OperationParamMap['api.call'];

    const result = await routeApiCall(params, makeEnvelope(), {}, renderClarifier);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('jobId');
    }
    expect(computeInvoke).not.toHaveBeenCalled();
  });

  it('fails fast when the compute bridge is unavailable', async () => {
    const renderClarifier = vi.fn<(body: StructuredClarifierBody, command: Envelope) => CommandResult<string>>(clarifierMock);
    computeBridgeSpy.mockReturnValue(undefined);

    const params: OperationParamMap['api.call'] = {
      method: 'POST',
      url: 'uicp://compute.call',
      body: {
        jobId: '00000000-0000-4000-8000-000000000abd',
        task: 'csv.parse@1.2.0',
      },
    };

    const result = await routeApiCall(params, makeEnvelope(), {}, renderClarifier);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('compute bridge not initialized');
    }
    expect(renderClarifier).not.toHaveBeenCalled();
  });

  it('delegates structured clarifier bodies to the renderer', async () => {
    computeBridgeSpy.mockReturnValue(undefined);
    const clarifierBody = {
      textPrompt: 'Provide more detail',
      windowId: 'clar-1',
      fields: [{ name: 'answer', label: 'Answer', required: true }],
    };
    const renderClarifier = vi.fn<(body: StructuredClarifierBody, command: Envelope) => CommandResult<string>>(() => ({ success: true as const, value: 'clarifier-rendered' }));

    const result = await routeApiCall(
      {
        method: 'POST',
        url: 'uicp://intent',
        body: clarifierBody,
      } as OperationParamMap['api.call'],
      makeEnvelope(),
      {},
      renderClarifier,
    );

    expect(result).toEqual({ success: true, value: 'clarifier-rendered' });
    expect(renderClarifier).toHaveBeenCalledTimes(1);
    expect(renderClarifier.mock.calls[0][0]).toMatchObject({ textPrompt: 'Provide more detail' });
  });

  it('dispatches an intent event when body contains freeform text', async () => {
    computeBridgeSpy.mockReturnValue(undefined);
    const renderClarifier = vi.fn<(body: StructuredClarifierBody, command: Envelope) => CommandResult<string>>(clarifierMock);
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    const result = await routeApiCall(
      {
        method: 'POST',
        url: 'uicp://intent',
        body: { text: 'Follow up with the user', windowId: 'win-action' },
      } as OperationParamMap['api.call'],
      makeEnvelope({ windowId: 'win-action' }),
      {},
      renderClarifier,
    );

    expect(result.success).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const event = dispatchSpy.mock.calls[0]?.[0];
    expect(event).toBeInstanceOf(CustomEvent);
    const intentEvent = event as CustomEvent<{ text: string; windowId: string }>;
    expect(intentEvent.type).toBe('uicp-intent');
    expect(intentEvent.detail).toMatchObject({ text: 'Follow up with the user', windowId: 'win-action' });
    expect(renderClarifier).not.toHaveBeenCalled();

    dispatchSpy.mockRestore();
  });
});
