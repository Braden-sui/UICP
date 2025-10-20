import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyBatch, registerWorkspaceRoot, clearWorkspaceRoot } from '../../src/lib/uicp/adapters/lifecycle';
import * as DomApplierModule from '../../src/lib/uicp/adapters/domApplier';

// Helper to get visible state of an element
const isVisible = (el: HTMLElement | null): boolean => {
  if (!el) return false;
  return el.style.display !== 'none';
};

describe('adapter.lifecycle v2 — state.watch + slots + api.into', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    root.id = 'workspace';
    registerWorkspaceRoot(root);
  });

  it("append mode appends successive renders (window scope, no slots)", async () => {
    // Create a window and a list container without slots
    await applyBatch([
      { op: 'window.create', params: { id: 'wA', title: 'Append Test' } },
      { op: 'dom.set', params: { windowId: 'wA', target: '#root', html: '<div id="list"></div>' } },
      { op: 'state.watch', params: { scope: 'window', windowId: 'wA', key: 'items', selector: '#list', mode: 'append' } },
    ] as any);

    // Two updates; since there are no slots, fallback path uses DomApplier with append mode
    await applyBatch([
      { op: 'state.set', params: { scope: 'window', windowId: 'wA', key: 'items', value: 'hello' } },
      { op: 'state.set', params: { scope: 'window', windowId: 'wA', key: 'items', value: 'world' } },
    ] as any);

    const container = (document.querySelector('#list') as HTMLElement | null);
    expect(container).toBeTruthy();
    const html = (container!.innerHTML || '').toLowerCase();
    expect(html).toContain('hello');
    expect(html).toContain('world');
    // Order should be preserved (hello then world)
    expect(html.indexOf('hello')).toBeLessThan(html.indexOf('world'));
  });

  it('api.call into with non-text/json response sets data:null and shows empty slot', async () => {
    // Shell with slots
    root.innerHTML = shellHtml;
    await applyBatch([
      { op: 'state.watch', params: { scope: 'workspace', key: 'blob', selector: '#users-shell' } },
    ] as any);

    // Mock binary response (e.g., image/png)
    const bin = new Uint8Array([1,2,3]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockResolvedValueOnce(new Response(
      bin,
      { status: 200, headers: { 'content-type': 'image/png' } }
    ) as any);

    await applyBatch([
      { op: 'api.call', params: { method: 'GET', url: 'https://example.com/img.png', idempotencyKey: 'load-img', into: { scope: 'workspace', key: 'blob' } } },
    ] as any);

    fetchSpy.mockRestore();

    // With data:null, watcher should show empty slot (not ready)
    const shell = root.querySelector('#users-shell') as HTMLElement;
    const ready = shell.querySelector('[data-slot="ready"]') as HTMLElement;
    const empty = shell.querySelector('[data-slot="empty"]') as HTMLElement;
    expect(isVisible(empty)).toBe(true);
    expect(isVisible(ready)).toBe(false);
  });

  afterEach(() => {
    clearWorkspaceRoot();
  });

  const shellHtml = [
    '<div id="users-shell">',
    '  <div data-slot="loading">Loading…</div>',
    '  <div data-slot="empty" style="display:none">No data</div>',
    '  <div data-slot="error" style="display:none"></div>',
    '  <div data-slot="ready" style="display:none"></div>',
    '</div>'
  ].join('');

  it('toggles loading → empty → ready → error slots via state.set (workspace scope)', async () => {
    // Seed shell directly into workspace root (workspace scope search)
    root.innerHTML = shellHtml;

    // Watch users key
    await applyBatch([
      { op: 'state.watch', params: { scope: 'workspace', key: 'users', selector: '#users-shell' } },
    ] as any);

    const getSlots = () => {
      const shell = root.querySelector('#users-shell') as HTMLElement | null;
      const loading = shell?.querySelector('[data-slot="loading"]') as HTMLElement | null;
      const empty = shell?.querySelector('[data-slot="empty"]') as HTMLElement | null;
      const error = shell?.querySelector('[data-slot="error"]') as HTMLElement | null;
      const ready = shell?.querySelector('[data-slot="ready"]') as HTMLElement | null;
      return { shell, loading, empty, error, ready };
    };

    // 1) loading
    await applyBatch([
      { op: 'state.set', params: { scope: 'workspace', key: 'users', value: { status: 'loading' } } },
    ] as any);
    {
      const { loading, empty, error, ready } = getSlots();
      expect(isVisible(loading)).toBe(true);
      expect(isVisible(empty)).toBe(false);
      expect(isVisible(error)).toBe(false);
      expect(isVisible(ready)).toBe(false);
    }

    // 2) empty (ready + empty data)
    await applyBatch([
      { op: 'state.set', params: { scope: 'workspace', key: 'users', value: { status: 'ready', data: [] } } },
    ] as any);
    {
      const { loading, empty, error, ready } = getSlots();
      expect(isVisible(loading)).toBe(false);
      expect(isVisible(empty)).toBe(true);
      expect(isVisible(error)).toBe(false);
      expect(isVisible(ready)).toBe(false);
    }

    // 3) ready (array of objects → table)
    await applyBatch([
      { op: 'state.set', params: { scope: 'workspace', key: 'users', value: { status: 'ready', data: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }] } } },
    ] as any);
    {
      const { ready } = getSlots();
      expect(isVisible(ready)).toBe(true);
      expect(ready!.innerHTML).toContain('<table');
      expect(ready!.innerHTML).toContain('name');
      expect(ready!.innerHTML).toContain('Alice');
    }

    // 4) error
    await applyBatch([
      { op: 'state.set', params: { scope: 'workspace', key: 'users', value: { status: 'error', error: 'boom' } } },
    ] as any);
    {
      const { error, loading, empty, ready } = getSlots();
      expect(isVisible(error)).toBe(true);
      expect(error!.textContent || '').toContain('boom');
      expect(isVisible(loading)).toBe(false);
      expect(isVisible(empty)).toBe(false);
      expect(isVisible(ready)).toBe(false);
    }
  });

  it('api.call into seeds loading then renders ready with fetched data', async () => {
    // Seed shell and watch
    root.innerHTML = shellHtml;
    await applyBatch([
      { op: 'state.watch', params: { scope: 'workspace', key: 'users', selector: '#users-shell' } },
    ] as any);

    // Mock fetch
    const mockJson = [{ id: 1, name: 'Carol' }];
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockResolvedValueOnce(new Response(
      JSON.stringify(mockJson),
      { status: 200, headers: { 'content-type': 'application/json' } }
    ) as any);

    await applyBatch([
      {
        op: 'api.call',
        params: {
          method: 'GET',
          url: 'https://example.com/users',
          idempotencyKey: 'load-users',
          into: { scope: 'workspace', key: 'users' },
        },
      },
    ] as any);

    fetchSpy.mockRestore();

    // Should have rendered ready with table containing Carol
    const shell = root.querySelector('#users-shell') as HTMLElement;
    const ready = shell.querySelector('[data-slot="ready"]') as HTMLElement;
    expect(isVisible(ready)).toBe(true);
    expect(ready.innerHTML).toContain('Carol');
  });

  it('state.patch updates nested values with a single watcher render', async () => {
    clearWorkspaceRoot();
    let domApplySpy: ReturnType<typeof vi.fn> | null = null;
    const actualCreateDomApplier = DomApplierModule.createDomApplier;
    const createDomApplierSpy = vi
      .spyOn(DomApplierModule, 'createDomApplier')
      .mockImplementation((...args) => {
        const instance = actualCreateDomApplier(...(args as Parameters<typeof actualCreateDomApplier>));
        const originalApply = instance.apply.bind(instance);
        const spy = vi.fn(async (params: Parameters<typeof instance.apply>[0]) => originalApply(params));
        (instance as typeof instance & { apply: typeof spy }).apply = spy;
        domApplySpy = spy;
        return instance;
      });

    try {
      root = document.createElement('div');
      root.id = 'workspace';
      registerWorkspaceRoot(root);
      root.innerHTML = '<div id="patch-target"></div>';

      await applyBatch([
        { op: 'state.watch', params: { scope: 'workspace', key: 'profile', selector: '#patch-target' } },
        {
          op: 'state.set',
          params: {
            scope: 'workspace',
            key: 'profile',
            value: { settings: { theme: 'light', flag: false } },
          },
        },
      ] as any);

      domApplySpy?.mockClear();

      await applyBatch([
        {
          op: 'state.patch',
          params: {
            scope: 'workspace',
            key: 'profile',
            ops: [
              { op: 'merge', path: 'settings', value: { layout: 'grid' } },
              { op: 'set', path: ['settings', 'theme'], value: 'dark' },
              { op: 'toggle', path: ['settings', 'flag'] },
            ],
          },
        },
      ] as any);

      expect(domApplySpy).toBeTruthy();
      expect(domApplySpy!.mock.calls.length).toBe(1);

      const target = root.querySelector('#patch-target') as HTMLElement | null;
      expect(target).toBeTruthy();
      const text = (target!.textContent || '').toLowerCase();
      expect(text).toContain('dark');
      expect(text).toContain('grid');
      expect(text).toContain('true');
    } finally {
      createDomApplierSpy.mockRestore();
    }
  });

  it('unwatch prevents further renders', async () => {
    root.innerHTML = shellHtml;
    await applyBatch([
      { op: 'state.watch', params: { scope: 'workspace', key: 'users', selector: '#users-shell' } },
      { op: 'state.set', params: { scope: 'workspace', key: 'users', value: { status: 'ready', data: [{ k: 'v1' }] } } },
    ] as any);

    const shell = root.querySelector('#users-shell') as HTMLElement;
    const ready = shell.querySelector('[data-slot="ready"]') as HTMLElement;
    const before = ready.innerHTML;

    // Unwatch and then set new value
    await applyBatch([
      { op: 'state.unwatch', params: { scope: 'workspace', key: 'users', selector: '#users-shell' } },
      { op: 'state.set', params: { scope: 'workspace', key: 'users', value: { status: 'ready', data: [{ k: 'v2' }] } } },
    ] as any);

    expect(ready.innerHTML).toBe(before);
  });

  it('window.close purges window-scoped watchers (no render after re-create)', async () => {
    // Create window, render shell via dom.set, and watch (window scope)
    await applyBatch([
      { op: 'window.create', params: { id: 'w1', title: 'Test' } },
      { op: 'dom.set', params: { windowId: 'w1', target: '#root', html: shellHtml } },
      { op: 'state.watch', params: { scope: 'window', windowId: 'w1', key: 'users', selector: '#users-shell' } },
      { op: 'window.close', params: { id: 'w1' } },
    ] as any);

    // Re-create window and set content again
    await applyBatch([
      { op: 'window.create', params: { id: 'w1', title: 'Test' } },
      { op: 'dom.set', params: { windowId: 'w1', target: '#root', html: shellHtml } },
      // If watcher remained, next set would render into the ready slot.
      { op: 'state.set', params: { scope: 'window', windowId: 'w1', key: 'users', value: { status: 'ready', data: [{ a: 1 }] } } },
    ] as any);

    const winRoot = (document.querySelector('[data-window-id="w1"]') || root) as HTMLElement;
    const shell = winRoot.querySelector('#users-shell') as HTMLElement | null;
    // Since our WindowManager may not add data-window-id in tests, fallback: fetch from document
    const ready = (shell || document).querySelector('[data-slot="ready"]') as HTMLElement | null;
    // No render should have occurred (ready slot remains hidden/empty)
    if (ready) {
      expect(ready.style.display === 'none' || ready.innerHTML === '').toBe(true);
    }
  });
});
