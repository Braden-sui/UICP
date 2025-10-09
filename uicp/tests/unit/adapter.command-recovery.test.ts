import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/uicp/queue', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/uicp/queue')>('../../src/lib/uicp/queue');
  return {
    ...actual,
    enqueueBatch: vi.fn(async () => undefined),
  };
});

import type { Batch } from '../../src/lib/uicp/schemas';
import { registerWorkspaceRoot, resetWorkspace } from '../../src/lib/uicp/adapter';
import { enqueueBatch } from '../../src/lib/uicp/queue';

describe('adapter data-command recovery', () => {
  beforeEach(() => {
    resetWorkspace();
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.id = 'workspace-root';
    document.body.appendChild(root);
    registerWorkspaceRoot(root);
    vi.mocked(enqueueBatch).mockClear();
  });

  it('repairs malformed data-command JSON before processing', async () => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.windowId = 'win-123';
    button.textContent = 'Play';
    button.setAttribute(
      'data-command',
      '{"batch":[{"op":"state.set","params":{"scope":"workspace","key":"status","value":playing}}]}',
    );
    document.getElementById('workspace-root')?.appendChild(button);

    const event = new MouseEvent('click', { bubbles: true });
    button.dispatchEvent(event);
    // Allow any microtasks scheduled by handlers to flush.
    await Promise.resolve();

    const enqueueSpy = vi.mocked(enqueueBatch);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const [batch] = enqueueSpy.mock.calls[0] ?? [];
    expect(Array.isArray(batch)).toBe(true);
    const env = (batch as Batch)[0];
    expect(env).toBeTruthy();
    if (env && env.op === 'state.set') {
      const p = env.params as import('../../src/lib/uicp/schemas').OperationParamMap['state.set'];
      expect(p.value).toBe('playing');
    } else {
      throw new Error(`expected first op to be state.set, got ${env?.op}`);
    }
    expect(button.getAttribute('data-command')).toBe(
      '{"batch":[{"op":"state.set","params":{"scope":"workspace","key":"status","value":"playing"}}]}',
    );
  });
});
