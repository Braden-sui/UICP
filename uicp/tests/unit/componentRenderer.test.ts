import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createComponentRenderer, getComponentCatalogSummary } from '../../src/lib/uicp/adapters/componentRenderer';
import type { DomApplier } from '../../src/lib/uicp/adapters/domApplier';

const resolvedPromise = Promise.resolve({ applied: 1, skippedDuplicates: 0 });

describe('componentRenderer', () => {
  let applyMock: ReturnType<typeof vi.fn>;
  let renderer: ReturnType<typeof createComponentRenderer>;
  let windowState: Map<string, unknown>;

  beforeEach(() => {
    applyMock = vi.fn().mockReturnValue(resolvedPromise);
    windowState = new Map<string, unknown>();
    const readState = (scope: 'window' | 'workspace' | 'global', key: string, windowId?: string) => {
      if (scope === 'window' && windowId) {
        return windowState.get(`${windowId}:${key}`);
      }
      return windowState.get(`${scope}:${key}`);
    };
    renderer = createComponentRenderer(
      { apply: applyMock } as unknown as DomApplier,
      { readState }
    );
  });

  it('renders known component type with provided id', async () => {
    await renderer.render({
      id: 'cmp-1',
      windowId: 'win-1',
      target: '#root',
      type: 'button.v1',
      props: { label: 'Click Me', command: 'do-something' },
    });

    expect(applyMock).toHaveBeenCalledTimes(1);
    const params = applyMock.mock.calls[0][0];
    expect(params.windowId).toBe('win-1');
    expect(params.target).toBe('#root');
    expect(params.mode).toBe('set');
    expect(params.sanitize).toBe(false);
    expect(params.html).toContain('data-component-id="cmp-1"');
    expect(params.html).toContain('Click Me');
  });

  it('updates component markup using merged props', async () => {
    await renderer.render({
      id: 'cmp-merge',
      windowId: 'win-merge',
      target: '#root',
      type: 'button.v1',
      props: { label: 'Initial', command: 'first' },
    });
    applyMock.mockClear();

    await renderer.update({ id: 'cmp-merge', props: { command: 'second' } });

    expect(applyMock).toHaveBeenCalledTimes(1);
    const params = applyMock.mock.calls[0][0];
    expect(params.windowId).toBe('win-merge');
    expect(params.target).toBe('[data-component-id="cmp-merge"]');
    expect(params.mode).toBe('set');
    expect(params.html).toContain('Initial');
    expect(params.html).toContain('data-command="second"');
  });

  it('throws when updating unknown component id', async () => {
    await expect(renderer.update({ id: 'missing' })).rejects.toThrow('component not found: missing');
  });

  it('destroys rendered components', async () => {
    await renderer.render({
      id: 'cmp-remove',
      windowId: 'win-remove',
      target: '#root',
      type: 'list.v1',
      props: { items: [{ text: 'One' }] },
    });
    applyMock.mockClear();

    await renderer.destroy({ id: 'cmp-remove' });

    expect(applyMock).toHaveBeenCalledTimes(1);
    const params = applyMock.mock.calls[0][0];
    expect(params.windowId).toBe('win-remove');
    expect(params.target).toBe('[data-component-id="cmp-remove"]');
    expect(params.mode).toBe('replace');
    expect(params.html).toBe('');
  });

  it('reads adapter state via data.view component', async () => {
    windowState.set('win-state:data', { count: 3, status: 'ready' });

    await renderer.render({
      id: 'cmp-state',
      windowId: 'win-state',
      target: '#root',
      type: 'data.view',
      props: { scope: 'window', path: 'data', transform: 'json' },
    });

    expect(applyMock).toHaveBeenCalledTimes(1);
    const params = applyMock.mock.calls[0][0];
    expect(params.html).toContain('count');
    expect(params.html).toContain('&quot;status&quot;: &quot;ready&quot;');
  });

  it('exposes catalog summaries for orchestrator consumption', () => {
    const instanceSummary = renderer.getCatalogSummary();
    const moduleSummary = getComponentCatalogSummary();

    expect(instanceSummary).toContain('data.table');
    expect(instanceSummary).toContain('Preference');
    expect(moduleSummary).toContain('data.table');
  });
});
