import { describe, it, expect, beforeEach } from 'vitest';
import { applyBatch, registerWorkspaceRoot, resetWorkspace } from '../../src/lib/uicp/adapter';
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
        op: 'dom.replace',
        params: { windowId: 'win-1', target: '#root', html: '<p data-testid="payload">Hello</p>' },
      },
    ]);

    const outcome = await applyBatch(batch);
    expect(outcome.success).toBe(true);
    expect(document.querySelector('[data-testid="payload"]')).not.toBeNull();
  });
});
