import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fsPlugin from '@tauri-apps/plugin-fs';

const confirmMock = vi.fn<(message: string, options?: { title?: string }) => Promise<boolean>>();

vi.mock('@tauri-apps/plugin-dialog', () => ({
  confirm: confirmMock,
}));

// Mock permissions to allow api.call operations in tests
vi.mock('../../src/lib/permissions/PermissionManager', () => ({
  checkPermission: vi.fn().mockResolvedValue('allow'),
}));

import { applyBatch, registerWorkspaceRoot, resetWorkspace, closeWorkspaceWindow, listWorkspaceWindows } from '../../src/lib/uicp/adapter';
import { validateBatch } from '../../src/lib/uicp/schemas';
import { nextFrame } from '../../src/lib/utils';
import { getTauriMocks } from '../mocks/tauri';

const getRuleStyle = (selector: string): CSSStyleDeclaration => {
  const sheets = Array.from(document.styleSheets) as CSSStyleSheet[];
  for (const sheet of sheets) {
    const rule = Array.from(sheet.cssRules).find(
      (cssRule): cssRule is CSSStyleRule =>
        cssRule instanceof CSSStyleRule && cssRule.selectorText === selector,
    );
    if (rule) return rule.style;
  }
  throw new Error(`Style rule ${selector} not found`);
};

// Adapter test ensures batches create DOM windows as expected.
describe('adapter.applyBatch', () => {
  beforeEach(() => {
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    resetWorkspace();
    const root = document.createElement('div');
    root.id = 'workspace-root';
    document.body.appendChild(root);
    registerWorkspaceRoot(root);
    const { invokeMock } = getTauriMocks();
    invokeMock.mockClear();
  });

  it('creates a window and injects HTML', async () => {
    const batch = validateBatch([
      {
        op: 'window.create',
        params: { id: 'win-1', title: 'Test', x: 20, y: 30, width: 400, height: 320 },
      },
      {
        op: 'dom.set',
        params: { windowId: 'win-1', target: '#root', html: '<p data-testid="payload">Hello</p>' },
      },
    ]);

    const outcome = await applyBatch(batch);
    await nextFrame();
    expect(outcome.success).toBe(true);
    expect(outcome.errors).toEqual([]);
    expect(document.querySelector('[data-testid="payload"]')).not.toBeNull();

    const { invokeMock } = getTauriMocks();
    const persistCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'persist_command');
    expect(persistCalls.length).toBe(2);
    expect(persistCalls).toEqual(
      expect.arrayContaining([
        [
          'persist_command',
          expect.objectContaining({
            cmd: expect.objectContaining({ tool: 'window.create' }),
          }),
        ],
        [
          'persist_command',
          expect.objectContaining({
            cmd: expect.objectContaining({ tool: 'dom.set' }),
          }),
        ],
      ]),
    );
  });

  it('tracks windows and allows menu-driven close', async () => {
    const batch = validateBatch([
      {
        op: 'window.create',
        params: { id: 'win-close', title: 'Closable', x: 10, y: 10, width: 260, height: 240 },
      },
    ]);

    await applyBatch(batch);
    await nextFrame();
    const snapshot = listWorkspaceWindows();
    expect(snapshot.find((entry: { id: string; title: string }) => entry.id === 'win-close')?.title).toBe('Closable');

    const { invokeMock } = getTauriMocks();
    invokeMock.mockClear();
    closeWorkspaceWindow('win-close');
    expect(document.querySelector('[data-window-id="win-close"]')).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith(
      'delete_window_commands',
      expect.objectContaining({ windowId: 'win-close' }),
    );
  });

  it('supports manual resize via window handles', async () => {
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1600 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 });

    try {
      const batch = validateBatch([
        {
          op: 'window.create',
          params: { id: 'win-resize', title: 'Resizable', x: 40, y: 60, width: 360, height: 320 },
        },
      ]);

      await applyBatch(batch);
      await nextFrame();

      const wrapper = document.querySelector('[data-window-id="win-resize"]') as HTMLDivElement | null;
      expect(wrapper).not.toBeNull();

      wrapper!.getBoundingClientRect = () => ({
        left: 100,
        top: 120,
        width: 360,
        height: 320,
        right: 460,
        bottom: 440,
        x: 100,
        y: 120,
        toJSON: () => ({}),
      });

      const eastHandle = wrapper!.querySelector('[data-resize-handle="east"]') as HTMLElement | null;
      expect(eastHandle).not.toBeNull();

      const styleBefore = getRuleStyle('[data-window-id="win-resize"]');
      expect(styleBefore.width).toBe('360px');
      expect(styleBefore.height).toBe('320px');

      eastHandle!.dispatchEvent(
        new PointerEvent('pointerdown', { pointerId: 1, bubbles: true, button: 0, clientX: 460, clientY: 260 }),
      );
      eastHandle!.dispatchEvent(
        new PointerEvent('pointermove', { pointerId: 1, bubbles: true, clientX: 520, clientY: 260 }),
      );
      eastHandle!.dispatchEvent(
        new PointerEvent('pointerup', { pointerId: 1, bubbles: true, clientX: 520, clientY: 260 }),
      );
      await nextFrame();

      wrapper!.getBoundingClientRect = () => ({
        left: 100,
        top: 120,
        width: 420,
        height: 320,
        right: 520,
        bottom: 440,
        x: 100,
        y: 120,
        toJSON: () => ({}),
      });

      const styleAfterWidth = getRuleStyle('[data-window-id="win-resize"]');
      expect(styleAfterWidth.width).toBe('420px');

      const southHandle = wrapper!.querySelector('[data-resize-handle="south"]') as HTMLElement | null;
      expect(southHandle).not.toBeNull();

      southHandle!.dispatchEvent(
        new PointerEvent('pointerdown', { pointerId: 2, bubbles: true, button: 0, clientX: 320, clientY: 440 }),
      );
      southHandle!.dispatchEvent(
        new PointerEvent('pointermove', { pointerId: 2, bubbles: true, clientX: 320, clientY: 500 }),
      );
      southHandle!.dispatchEvent(
        new PointerEvent('pointerup', { pointerId: 2, bubbles: true, clientX: 320, clientY: 500 }),
      );
      await nextFrame();

      const styleAfterHeight = getRuleStyle('[data-window-id="win-resize"]');
      expect(styleAfterHeight.height).toBe('380px');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: originalInnerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: originalInnerHeight });
    }
  });

  it('renders structured clarifier form via intent metadata', async () => {
    const clarifierBatch = validateBatch([
      {
        op: 'api.call',
        params: {
          method: 'POST',
          url: 'uicp://intent',
          body: {
            textPrompt: 'Which city should I show weather for?',
            submit: 'Continue',
            fields: [{ name: 'city', label: 'City', placeholder: 'e.g., San Francisco' }],
          },
        },
      },
    ]);

    const outcome = await applyBatch(clarifierBatch);
    await nextFrame();
    expect(outcome.success).toBe(true);
    expect(outcome.errors).toEqual([]);

    const windowEl = document.querySelector('[data-window-id]');
    expect(windowEl).not.toBeNull();
    expect(windowEl?.textContent).toContain('Which city should I show weather for?');

    const input = windowEl?.querySelector('input[name="city"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input?.placeholder).toBe('e.g., San Francisco');

    const submit = windowEl?.querySelector('button[type="submit"]');
    expect(submit).not.toBeNull();
    const commands = JSON.parse(submit?.getAttribute('data-command') ?? '[]');
    expect(Array.isArray(commands)).toBe(true);
    expect(commands[0]?.op).toBe('api.call');
    expect(commands.some((cmd: any) => cmd.op === 'window.close')).toBe(true);

    const { invokeMock } = getTauriMocks();
    const persistCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'persist_command');
    expect(persistCalls.length).toBe(0);
  });

  it('fails loudly when api.call network request rejects', async () => {
    const originalFetch = globalThis.fetch;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('network offline'));
      const batch = validateBatch([
        {
          op: 'api.call',
          params: {
            url: 'https://example.test/data',
            method: 'POST',
            body: { ping: true },
          },
        },
      ]);

      const outcome = await applyBatch(batch);
      await nextFrame();
      expect(outcome.success).toBe(false);
      expect(outcome.errors[0]).toContain('api.call');
      expect(outcome.errors[0]).toContain('network offline');
    } finally {
      errorSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  it('fails loudly when tauri fs write rejects', async () => {
    const writeSpy = vi.spyOn(fsPlugin, 'writeTextFile').mockRejectedValue(new Error('fs denied'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const batch = validateBatch([
        {
          op: 'api.call',
          params: {
            url: 'tauri://fs/writeTextFile',
            body: { path: 'note.txt', contents: 'hi there', directory: 'Downloads' },
          },
        },
      ]);

      const outcome = await applyBatch(batch);
      await nextFrame();
      expect(outcome.success).toBe(false);
      expect(outcome.errors[0]).toContain('api.call');
      expect(outcome.errors[0]).toContain('fs denied');
    } finally {
      errorSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  it('requires user confirmation before writing to Desktop and aborts when denied', async () => {
    confirmMock.mockResolvedValueOnce(false);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const writeSpy = vi.spyOn(fsPlugin, 'writeTextFile').mockResolvedValue();
    try {
      const batch = validateBatch([
        {
          op: 'api.call',
          params: {
            url: 'tauri://fs/writeTextFile',
            body: { path: 'exports/report.txt', contents: 'hi there', directory: 'Desktop' },
          },
        },
      ]);

      const outcome = await applyBatch(batch);
      await nextFrame();
      expect(outcome.success).toBe(false);
      expect(outcome.errors[0]).toContain('E-UICP-6202');
      expect(confirmMock).toHaveBeenCalledWith(
        expect.stringContaining('exports/report.txt'),
        expect.objectContaining({ title: 'Desktop export' }),
      );
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  it('writes to Desktop after confirmation succeeds', async () => {
    const writeSpy = vi.spyOn(fsPlugin, 'writeTextFile').mockResolvedValue();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const batch = validateBatch([
        {
          op: 'api.call',
          params: {
            url: 'tauri://fs/writeTextFile',
            body: { path: 'exports/ok.txt', contents: 'hello', directory: 'Desktop' },
          },
        },
      ]);

      const outcome = await applyBatch(batch);
      await nextFrame();
      expect(outcome.success).toBe(true);
      expect(confirmMock).toHaveBeenCalled();
      expect(writeSpy).toHaveBeenCalledWith(
        'exports/ok.txt',
        'hello',
        expect.objectContaining({ baseDir: fsPlugin.BaseDirectory.Desktop }),
      );
      expect(infoSpy).toHaveBeenCalledWith('desktop export confirmed', expect.any(Object));
    } finally {
      infoSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });
});
