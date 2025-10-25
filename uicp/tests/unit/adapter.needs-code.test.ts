import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../../src/lib/telemetry', () => ({
  emitTelemetryEvent: vi.fn(),
}));

import type { CommandExecutorDeps } from '../../src/lib/uicp/adapters/adapter.commands';
import { createCommandTable } from '../../src/lib/uicp/adapters/adapter.commands';
import { emitTelemetryEvent } from '../../src/lib/telemetry';
import { useProviderStore } from '../../src/state/providers';

describe('needs.code executor', () => {
  afterEach(() => {
    delete (window as unknown as { uicpComputeCall?: unknown }).uicpComputeCall;
    vi.clearAllMocks();
    const store = useProviderStore.getState();
    store.setEnableBoth(true);
    store.setDefaultProvider('auto');
    store.resetAll();
  });

  it('persists artifact state and renders install panel on success', async () => {
    const table = createCommandTable();
    const executor = table['needs.code'];
    expect(executor).toBeDefined();

    const setStateValue = vi.fn<NonNullable<CommandExecutorDeps['setStateValue']>>(() => {});
    const executeDomSet = vi.fn<NonNullable<CommandExecutorDeps['executeDomSet']>>(() => ({
      success: true as const,
      value: 'status',
    }));
    const executeComponentRender = vi.fn<NonNullable<CommandExecutorDeps['executeComponentRender']>>(() => ({
      success: true as const,
      value: 'panel-123',
    }));
    const ensureWindowExists = vi.fn<NonNullable<CommandExecutorDeps['ensureWindowExists']>>(async () => ({
      success: true as const,
      value: 'app-window',
    }));

    let dispatchedJobId: string | undefined;
    let dispatchedSpec: any;

    (window as any).uicpComputeCall = vi.fn(async (spec: any) => {
      dispatchedJobId = spec.jobId;
      dispatchedSpec = spec;
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent('uicp-compute-final', {
            detail: {
              ok: true,
              jobId: spec.jobId,
              task: spec.task,
              output: {
                code: 'export const render = () => ({ html: "<div>demo</div>" });',
                language: 'ts',
                meta: { provider: 'openai' },
              },
              metrics: { cacheHit: true },
            },
          }),
        );
      }, 0);
    });

    const command = {
      op: 'needs.code',
      params: {
        spec: 'Generate widget',
        language: 'ts',
        artifactId: 'demo-artifact',
        progressWindowId: 'w1',
        progressSelector: '#status',
        install: {
          panelId: 'panel-demo',
          windowId: 'app-window',
          target: '#root',
          stateKey: 'panels.panel-demo.view',
        },
      },
    } as unknown as import('../../src/lib/schema').Envelope<'needs.code'>;

    const result = await executor.execute(command, { runId: 'run-1' }, {
      executeDomSet,
      setStateValue,
      executeComponentRender,
      ensureWindowExists,
    });

    expect(result.success).toBe(true);
    expect(window.uicpComputeCall).toHaveBeenCalledTimes(1);
    expect(dispatchedJobId).toBeDefined();
    expect(dispatchedSpec.input.provider).toBe('auto');
    expect(dispatchedSpec.input.strategy).toBe('sequential-fallback');
    expect(dispatchedSpec.input.install).toEqual({
      panelId: 'panel-demo',
      windowId: 'app-window',
      target: '#root',
      stateKey: 'panels.panel-demo.view',
    });
    expect(dispatchedSpec.capabilities.net).toEqual([
      'https://api.openai.com',
      'https://api.anthropic.com',
    ]);

    // Allow final handler to settle
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(setStateValue).toHaveBeenCalled();
    const stateKeys = setStateValue.mock.calls.map(([callParams]) => callParams.key);
    expect(stateKeys).toContain('artifacts.demo-artifact');
    expect(stateKeys).toContain('artifacts.demo-artifact.code');
    expect(stateKeys).toContain('artifacts.demo-artifact.language');
    expect(stateKeys).toContain('artifacts.demo-artifact.meta');

    const baseCall = setStateValue.mock.calls.find(([callParams]) => callParams.key === 'artifacts.demo-artifact');
    expect(baseCall?.[0]).toMatchObject({
      scope: 'workspace',
      value: {
        code: expect.any(String),
        language: 'ts',
        meta: { provider: 'openai' },
      },
    });

    expect(ensureWindowExists).toHaveBeenCalledWith('app-window', { id: 'app-window', title: 'app-window' });
    expect(executeComponentRender).toHaveBeenCalledWith({
      id: 'panel-demo',
      windowId: 'app-window',
      target: '#root',
      type: 'script.panel',
      props: {
        id: 'panel-demo',
        module: 'applet.quickjs@0.1.0',
        sourceKey: 'workspace.artifacts.demo-artifact.code',
        stateKey: 'panels.panel-demo.view',
      },
    });

    expect(emitTelemetryEvent).toHaveBeenCalledWith(
      'needs_code_artifact',
      expect.objectContaining({
        traceId: 'run-1',
        data: expect.objectContaining({
          artifactKey: 'workspace.artifacts.demo-artifact',
          installRequested: true,
          installSucceeded: true,
          panelId: 'panel-demo',
          windowId: 'app-window',
        }),
      }),
    );
  });

  it('applies provider-specific network allowlists', async () => {
    const table = createCommandTable();
    const executor = table['needs.code'];
    const baselineCommand = {
      op: 'needs.code',
      params: {
        spec: 'Generate widget',
        language: 'ts',
      },
    } as unknown as import('../../src/lib/schema').Envelope<'needs.code'>;

    const dispatches: any[] = [];
    (window as any).uicpComputeCall = vi.fn(async (spec: any) => {
      dispatches.push(spec);
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent('uicp-compute-final', {
            detail: {
              ok: false,
              jobId: spec.jobId,
              task: spec.task,
              code: 'Compute.Cancelled',
              message: 'cancelled for test',
            },
          }),
        );
      }, 0);
    });

    await executor.execute(
      ({
        ...baselineCommand,
        params: { ...baselineCommand.params, provider: 'codex' },
      } as unknown) as import('../../src/lib/schema').Envelope<'needs.code'>,
      {},
      {},
    );
    await executor.execute(
      ({
        ...baselineCommand,
        params: { ...baselineCommand.params, provider: 'claude', providers: ['claude'] },
      } as unknown) as import('../../src/lib/schema').Envelope<'needs.code'>,
      {},
      {},
    );
    await executor.execute(
      ({
        ...baselineCommand,
        params: {
          ...baselineCommand.params,
          providers: ['codex', 'claude'],
          caps: { net: ['https://api.openai.com/v1/chat', 'https://malicious.example.com'] },
        },
      } as unknown) as import('../../src/lib/schema').Envelope<'needs.code'>,
      {},
      {},
    );

    expect(dispatches).toHaveLength(3);
    expect(dispatches[0].capabilities.net).toEqual(['https://api.openai.com']);
    expect(dispatches[1].capabilities.net).toEqual(['https://api.anthropic.com']);
    expect(dispatches[2].capabilities.net).toEqual(['https://api.openai.com/v1/chat', 'https://api.anthropic.com']);
  });
  it('respects provider store defaults when planner leaves provider unset', async () => {
    const table = createCommandTable();
    const executor = table['needs.code'];
    const baselineCommand = {
      op: 'needs.code',
      params: {
        spec: 'Generate widget',
        language: 'ts',
      },
    } as unknown as import('../../src/lib/schema').Envelope<'needs.code'>;

    const store = useProviderStore.getState();
    store.setEnableBoth(false);
    store.setDefaultProvider('claude');
    store.resetAll();

    const dispatches: any[] = [];
    (window as any).uicpComputeCall = vi.fn(async (spec: any) => {
      dispatches.push(spec);
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent('uicp-compute-final', {
            detail: {
              ok: false,
              jobId: spec.jobId,
              task: spec.task,
              code: 'Compute.Cancelled',
              message: 'cancelled for test',
            },
          }),
        );
      }, 0);
    });

    await executor.execute(baselineCommand, {}, {});

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].input.provider).toBe('claude');
    expect(dispatches[0].capabilities.net).toEqual(['https://api.anthropic.com']);
  });
});

