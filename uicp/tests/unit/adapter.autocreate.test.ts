import { describe, it, expect, beforeEach } from 'vitest';
import { applyBatch, registerWorkspaceRoot, resetWorkspace } from '../../src/lib/uicp/adapter';
import { validateBatch } from '../../src/lib/uicp/schemas';
import { getTauriMocks } from '../mocks/tauri';

describe('adapter auto-create window for targeted ops', () => {
  beforeEach(() => {
    resetWorkspace();
    const existing = document.getElementById('workspace-root');
    if (existing) existing.remove();
    const root = document.createElement('div');
    root.id = 'workspace-root';
    document.body.appendChild(root);
    registerWorkspaceRoot(root);
    const { invokeMock } = getTauriMocks();
    invokeMock.mockClear();
  });

  it('dom.set bootstraps a missing window and persists create', async () => {
    const batch = validateBatch([
      { op: 'dom.set', params: { windowId: 'win-auto', target: '#root', html: '<p id="payload">Hello</p>' } },
    ]);

    const outcome = await applyBatch(batch);
    expect(outcome.success).toBe(true);
    expect(document.querySelector('[data-window-id="win-auto"]')).not.toBeNull();
    expect(document.getElementById('payload')?.textContent).toBe('Hello');

    const { invokeMock } = getTauriMocks();
    const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'persist_command');
    // Expect both the synthetic window.create and the dom.set to be persisted
    const tools = calls.map(([, args]) => (args as any).cmd.tool).sort();
    expect(tools).toEqual(['dom.set', 'window.create']);
  });

  it('window.update creates window when missing and applies title', async () => {
    const batch = validateBatch([
      { op: 'window.update', params: { id: 'win-update-auto', title: 'Auto Gallery', width: 400, height: 300 } },
    ]);
    const outcome = await applyBatch(batch);
    expect(outcome.success).toBe(true);
    const shell = document.querySelector('[data-window-id="win-update-auto"]');
    expect(shell).not.toBeNull();
    expect(shell?.textContent).toContain('Auto Gallery');

    const { invokeMock } = getTauriMocks();
    const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'persist_command');
    // Should persist at least the synthetic create and the update
    const tools = calls.map(([, args]) => (args as any).cmd.tool).sort();
    expect(tools).toEqual(['window.create', 'window.update']);
  });
});

