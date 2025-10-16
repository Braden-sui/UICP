import { describe, it, expect, beforeEach } from 'vitest';
import { buildEnvironmentSnapshot } from '../../src/lib/env';
import { registerWorkspaceRoot, resetWorkspace, applyBatch } from '../../src/lib/uicp/adapter';
import { validateBatch } from '../../src/lib/uicp/schemas';

describe('buildEnvironmentSnapshot', () => {
  beforeEach(async () => {
    resetWorkspace();
    const existing = document.getElementById('workspace-root');
    if (existing) existing.remove();
    const root = document.createElement('div');
    root.id = 'workspace-root';
    document.body.appendChild(root);
    registerWorkspaceRoot(root);
  });

  it('includes agent flags and workspace window ids', async () => {
    const batch = validateBatch([
      { op: 'window.create', params: { id: 'win-sample', title: 'Sample', width: 320, height: 240 } },
    ]);
    await applyBatch(batch);

    const snapshot = buildEnvironmentSnapshot();
    expect(snapshot).toContain('Environment Snapshot');
    expect(snapshot).toMatch(/Agent: phase=/);
    expect(snapshot).toContain('WorkspaceWindows');
    expect(snapshot).toContain('win-sample');
  });
});

