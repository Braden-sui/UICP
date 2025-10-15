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

describe('adapter data-command strict parsing', () => {
  beforeEach(() => {
    resetWorkspace();
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.id = 'workspace-root';
    document.body.appendChild(root);
    registerWorkspaceRoot(root);
    vi.mocked(enqueueBatch).mockClear();
  });

  it('rejects malformed data-command JSON without recovery', async () => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.windowId = 'win-123';
    button.textContent = 'Play';
    // Malformed JSON: missing quotes around "playing"
    button.setAttribute(
      'data-command',
      '{"batch":[{"op":"state.set","params":{"scope":"workspace","key":"status","value":playing}}]}',
    );
    document.getElementById('workspace-root')?.appendChild(button);

    // Malformed JSON should surface an error event with E-UICP-301.
    const captured: Error[] = [];
    const handler = (evt: ErrorEvent) => {
      evt.preventDefault();
      const err = evt.error instanceof Error ? evt.error : new Error(evt.message);
      captured.push(err);
    };
    window.addEventListener('error', handler);
    const event = new MouseEvent('click', { bubbles: true });
    button.dispatchEvent(event);
    window.removeEventListener('error', handler);
    await Promise.resolve();
    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured[0]?.message).toMatch(/E-UICP-301/);

    // Should NOT have enqueued anything due to parse failure
    const enqueueSpy = vi.mocked(enqueueBatch);
    expect(enqueueSpy).toHaveBeenCalledTimes(0);
  });

  it('processes valid data-command JSON correctly', async () => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.windowId = 'win-123';
    button.textContent = 'Play';
    // Valid JSON with proper quotes
    button.setAttribute(
      'data-command',
      '{"batch":[{"op":"state.set","params":{"scope":"workspace","key":"status","value":"playing"}}]}',
    );
    document.getElementById('workspace-root')?.appendChild(button);

    const event = new MouseEvent('click', { bubbles: true });
    button.dispatchEvent(event);
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
  });
  it('rejects empty batches emitted via data-command', async () => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.windowId = 'win-123';
    button.textContent = 'Empty';
    button.setAttribute('data-command', '{"batch":[]}');
    document.getElementById('workspace-root')?.appendChild(button);

    const captured: Error[] = [];
    const handler = (evt: ErrorEvent) => {
      evt.preventDefault();
      const err = evt.error instanceof Error ? evt.error : new Error(evt.message);
      captured.push(err);
    };
    window.addEventListener('error', handler);
    const event = new MouseEvent('click', { bubbles: true });
    button.dispatchEvent(event);
    window.removeEventListener('error', handler);
    await Promise.resolve();
    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured[0]?.message).toMatch(/E-UICP-301/);
    expect(vi.mocked(enqueueBatch)).not.toHaveBeenCalled();
  });
});
