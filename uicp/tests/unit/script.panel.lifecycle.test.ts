import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyBatch, registerWorkspaceRoot, clearWorkspaceRoot } from '../../src/lib/uicp/adapters/lifecycle';

// Helper to flush microtasks between async DOM-applied updates
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('script.panel lifecycle + script.emit bridge', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    root.id = 'workspace';
    registerWorkspaceRoot(root);
  });

  afterEach(() => {
    clearWorkspaceRoot();
  });

  it('renders wrapper and initial HTML via DIRECT init + INTO render', async () => {
    // Arrange: create window and render script.panel with inline module
    const panelId = 'panel-1';
    const moduleObj = {
      init() { return { count: 0 }; },
      render({ state }: { state: any }) {
        const n = (state && typeof state.count === 'number') ? state.count : -1;
        return { html: `<div><div data-testid="count">${n}</div><button id="inc" data-command='{"type":"script.emit","action":"inc"}'>+</button></div>` };
      },
      onEvent({ action, state }: { action: string; state: any }) {
        if (action === 'inc') return { next_state: { count: (state?.count ?? 0) + 1 } };
        return {};
      },
    };

    await applyBatch([
      { op: 'window.create', params: { id: 'w1', title: 'Test' } },
      { op: 'component.render', params: { windowId: 'w1', target: '#root', type: 'script.panel', props: { id: panelId, module: moduleObj } } },
    ] as any);

    await tick();

    // Assert wrapper exists and initial render shows count 0
    const wrapper = root.querySelector(`.uicp-script-panel[data-script-panel-id="${panelId}"]`) as HTMLElement | null;
    expect(wrapper).toBeTruthy();
    const countEl = wrapper!.querySelector('[data-testid="count"]') as HTMLElement | null;
    expect(countEl).toBeTruthy();
    expect((countEl!.textContent || '').trim()).toBe('0');
  });

  it('handles script.emit to update model and re-render via INTO', async () => {
    const panelId = 'panel-2';
    const moduleObj = {
      init() { return { count: 1 }; },
      render({ state }: { state: any }) {
        const n = (state && typeof state.count === 'number') ? state.count : -1;
        return { html: `<div><div data-testid="count">${n}</div><button id="inc" data-command='{"type":"script.emit","action":"inc"}'>+</button></div>` };
      },
      onEvent({ action, state }: { action: string; state: any }) {
        if (action === 'inc') return { next_state: { count: (state?.count ?? 0) + 1 } };
        return {};
      },
    };

    await applyBatch([
      { op: 'window.create', params: { id: 'w2', title: 'Test 2' } },
      { op: 'component.render', params: { windowId: 'w2', target: '#root', type: 'script.panel', props: { id: panelId, module: moduleObj } } },
    ] as any);

    await tick();

    const wrapper = root.querySelector(`.uicp-script-panel[data-script-panel-id="${panelId}"]`) as HTMLElement | null;
    const inc = wrapper?.querySelector('#inc') as HTMLButtonElement | null;
    expect(inc).toBeTruthy();

    // Act: click button to emit event
    inc!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();

    // Assert: count incremented and DOM updated
    const countEl = wrapper!.querySelector('[data-testid="count"]') as HTMLElement | null;
    expect(countEl).toBeTruthy();
    expect((countEl!.textContent || '').trim()).toBe('2');
  });
});
