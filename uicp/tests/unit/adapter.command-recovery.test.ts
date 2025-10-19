import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock lifecycle to signal workspace is always ready
vi.mock('../../src/lib/uicp/adapters/lifecycle', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/uicp/adapters/lifecycle')>(
    '../../src/lib/uicp/adapters/lifecycle',
  );
  return {
    ...actual,
    deferBatchIfNotReady: () => null, // workspace is always ready in tests
  };
});

vi.mock('../../src/lib/uicp/adapters/queue', () => ({
  enqueueBatch: vi.fn(async () => ({ success: true, applied: 1, errors: [], skippedDupes: 0 })),
  clearAllQueues: vi.fn(),
  createPartitionQueue: vi.fn(),
}));

import type { Batch } from '../../src/lib/uicp/schemas';
import { registerWorkspaceRoot, resetWorkspace } from '../../src/lib/uicp/adapter';
import { enqueueBatch } from '../../src/lib/uicp/adapters/queue';

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

    // Spy on console.error to capture the error
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    const event = new MouseEvent('click', { bubbles: true });
    button.dispatchEvent(event);
    await Promise.resolve();
    
    // Should have logged error with E-UICP-0301
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/E-UICP-0301/),
      expect.any(Error)
    );
    
    consoleErrorSpy.mockRestore();

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

    // Spy on console.error to capture the error
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    const event = new MouseEvent('click', { bubbles: true });
    button.dispatchEvent(event);
    await Promise.resolve();
    
    // Should have logged error with E-UICP-0301
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/E-UICP-0301/),
      expect.any(Error)
    );
    
    consoleErrorSpy.mockRestore();
    
    expect(vi.mocked(enqueueBatch)).not.toHaveBeenCalled();
  });

  it('rejects data-command JSON exceeding MAX_DATA_COMMAND_LEN with E-UICP-0300', async () => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.windowId = 'win-123';
    // Construct a valid JSON envelope with a very large noop payload string to exceed 32KB
    const big = 'x'.repeat(33 * 1024);
    const payload = { batch: [{ op: 'state.set', params: { scope: 'workspace', key: 'big', value: big } }] };
    btn.setAttribute('data-command', JSON.stringify(payload));
    document.getElementById('workspace-root')?.appendChild(btn);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/E-UICP-0301/),
      expect.any(Error)
    );
    // Enqueue should not be called when caps are exceeded
    expect(vi.mocked(enqueueBatch)).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('rejects data-command JSON with too many template tokens (>{{}} cap) with E-UICP-0300', async () => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.windowId = 'win-123';
    // Build an HTML string containing 17 template tokens to exceed the default cap of 16
    const tokens = Array.from({ length: 17 }, (_, i) => `{{t${i}}}`).join(' ');
    const html = `<div>${tokens}</div>`;
    const payload = { batch: [{ op: 'dom.set', params: { windowId: 'win-123', target: '#root', html } }] };
    btn.setAttribute('data-command', JSON.stringify(payload));
    document.getElementById('workspace-root')?.appendChild(btn);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/E-UICP-0301/),
      expect.any(Error)
    );
    expect(vi.mocked(enqueueBatch)).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
