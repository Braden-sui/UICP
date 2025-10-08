import { describe, it, expect, beforeEach } from 'vitest';
import { registerWorkspaceRoot, resetWorkspace, replayWorkspace } from '../../src/lib/uicp/adapter';
import { getTauriMocks } from '../mocks/tauri';

describe('adapter.replayWorkspace', () => {
  beforeEach(() => {
    resetWorkspace();
    // Fresh root each test
    const existing = document.getElementById('workspace-root');
    if (existing) existing.remove();
    const root = document.createElement('div');
    root.id = 'workspace-root';
    document.body.appendChild(root);
    registerWorkspaceRoot(root);
  });

  it('preserves destroy-before-create ordering for same window id', async () => {
    const { invokeMock } = getTauriMocks();
    // Return a sequence where a previous window generation was closed
    // and then re-created with the same id (stable window id reuse).
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_workspace_commands') {
        return [
          { id: '1', tool: 'window.close', args: { id: 'win-stable' } },
          { id: '2', tool: 'window.create', args: { id: 'win-stable', title: 'Stable Window', width: 360, height: 240 } },
          { id: '3', tool: 'dom.set', args: { windowId: 'win-stable', target: '#root', html: '<p data-testid="ok">OK</p>' } },
        ];
      }
      return undefined;
    });

    const { applied, errors } = await replayWorkspace();

    // All three should apply; close is a no-op if absent, then create, then dom.set
    expect(applied).toBe(3);
    expect(errors).toEqual([]);
    expect(document.querySelector('[data-window-id="win-stable"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="ok"]')).not.toBeNull();
  });
});

