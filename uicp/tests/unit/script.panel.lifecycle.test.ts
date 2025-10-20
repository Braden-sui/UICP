import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyBatch, registerWorkspaceRoot, clearWorkspaceRoot } from '../../src/lib/uicp/adapters/lifecycle';

// Helper to flush microtasks between async DOM-applied updates
const tick = () => new Promise((r) => setTimeout(r, 0));

type ScriptState = { count: number };

const dispatchFinal = (detail: import('../../src/compute/types').ComputeFinalEvent) => {
  window.dispatchEvent(new CustomEvent('uicp-compute-final', { detail }));
};

describe('script.panel lifecycle + script.emit bridge', () => {
  let root: HTMLElement;
  let currentState: ScriptState;

  beforeEach(() => {
    root = document.createElement('div');
    root.id = 'workspace';
    registerWorkspaceRoot(root);
    currentState = { count: 0 };
  });

  afterEach(() => {
    delete (window as any).uicpComputeCall;
    clearWorkspaceRoot();
  });

  const installComputeStub = (initialCount: number) => {
    currentState = { count: initialCount };
    (window as any).uicpComputeCall = async (spec: import('../../src/compute/types').JobSpec) => {
      const mode = (spec.input as Record<string, unknown>).mode as string;
      if (mode === 'init') {
        currentState = { count: initialCount };
        setTimeout(() => {
          dispatchFinal({
            ok: true,
            jobId: spec.jobId,
            task: spec.task,
            output: { status: 'ready', mode: 'init', data: JSON.stringify(currentState) },
            metrics: {},
          } as any);
        }, 0);
        return;
      }

      if (mode === 'render') {
        const stateStr = String((spec.input as Record<string, unknown>).state ?? '{}');
        try {
          const parsed = JSON.parse(stateStr);
          if (typeof parsed?.count === 'number') {
            currentState = { count: parsed.count };
          }
        } catch {
          currentState = { count: initialCount };
        }
        const html = `<div><div data-testid="count">${currentState.count}</div><button id="inc" data-command='{"type":"script.emit","action":"inc"}'>+</button></div>`;
        setTimeout(() => {
          dispatchFinal({
            ok: true,
            jobId: spec.jobId,
            task: spec.task,
            output: { status: 'ready', mode: 'render', html },
            metrics: {},
          } as any);
        }, 0);
        return;
      }

      if (mode === 'on-event') {
        const action = String((spec.input as Record<string, unknown>).action ?? '');
        const stateStr = String((spec.input as Record<string, unknown>).state ?? '{}');
        try {
          const parsed = JSON.parse(stateStr);
          if (typeof parsed?.count === 'number') {
            currentState = { count: parsed.count };
          }
        } catch {
          currentState = { count: initialCount };
        }
        if (action === 'inc') {
          currentState = { count: currentState.count + 1 };
        }
        const payload = {
          next_state: JSON.stringify(currentState),
        };
        setTimeout(() => {
          dispatchFinal({
            ok: true,
            jobId: spec.jobId,
            task: spec.task,
            output: { status: 'ready', mode: 'on-event', data: JSON.stringify(payload) },
            metrics: {},
          } as any);
        }, 0);
      }
    };
  };

  it('renders wrapper and initial HTML via init + render jobs', async () => {
    const panelId = 'panel-1';
    installComputeStub(0);

    await applyBatch([
      { op: 'window.create', params: { id: 'w1', title: 'Test' } },
      {
        op: 'component.render',
        params: {
          windowId: 'w1',
          target: '#root',
          type: 'script.panel',
          props: { id: panelId, stateKey: `panels.${panelId}.view`, module: 'applet.quickjs@0.1.0', source: '// stubbed' },
        },
      },
    ] as any);

    await tick();

    const wrapper = root.querySelector(`.uicp-script-panel[data-script-panel-id="${panelId}"]`) as HTMLElement | null;
    expect(wrapper).toBeTruthy();
    const countEl = wrapper!.querySelector('[data-testid="count"]') as HTMLElement | null;
    expect(countEl).toBeTruthy();
    expect((countEl!.textContent || '').trim()).toBe('0');
  });

  it('handles script.emit to update model and re-render', async () => {
    const panelId = 'panel-2';
    installComputeStub(1);

    await applyBatch([
      { op: 'window.create', params: { id: 'w2', title: 'Test 2' } },
      {
        op: 'component.render',
        params: {
          windowId: 'w2',
          target: '#root',
          type: 'script.panel',
          props: { id: panelId, stateKey: `panels.${panelId}.view`, module: 'applet.quickjs@0.1.0', source: '// stubbed' },
        },
      },
    ] as any);

    await tick();

    const wrapper = root.querySelector(`.uicp-script-panel[data-script-panel-id="${panelId}"]`) as HTMLElement | null;
    const inc = wrapper?.querySelector('#inc') as HTMLButtonElement | null;
    expect(inc).toBeTruthy();

    inc!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();

    const countEl = wrapper!.querySelector('[data-testid="count"]') as HTMLElement | null;
    expect(countEl).toBeTruthy();
    expect((countEl!.textContent || '').trim()).toBe('2');
  });
});
