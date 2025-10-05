import { describe, it, expect, beforeEach } from 'vitest';
import { applyBatch, registerWorkspaceRoot, resetWorkspace, closeWorkspaceWindow, listWorkspaceWindows } from '../../src/lib/uicp/adapter';
import { validateBatch } from '../../src/lib/uicp/schemas';

// Adapter test ensures batches create DOM windows as expected.
describe('adapter.applyBatch', () => {
  beforeEach(() => {
    resetWorkspace();
    const root = document.createElement('div');
    root.id = 'workspace-root';
    document.body.appendChild(root);
    registerWorkspaceRoot(root);
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
    expect(outcome.success).toBe(true);
    expect(document.querySelector('[data-testid="payload"]')).not.toBeNull();
  });

  it('tracks windows and allows menu-driven close', async () => {
    const batch = validateBatch([
      {
        op: 'window.create',
        params: { id: 'win-close', title: 'Closable', x: 10, y: 10, width: 260, height: 240 },
      },
    ]);

    await applyBatch(batch);
    const snapshot = listWorkspaceWindows();
    expect(snapshot.find((entry) => entry.id === 'win-close')?.title).toBe('Closable');
    closeWorkspaceWindow('win-close');
    expect(document.querySelector('[data-window-id=\"win-close\"]')).toBeNull();
  });
});
