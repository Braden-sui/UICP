import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock lifecycle to signal workspace is always ready
vi.mock('../../src/lib/uicp/adapters/adapter.lifecycle', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/uicp/adapters/adapter.lifecycle')>(
    '../../src/lib/uicp/adapters/adapter.lifecycle',
  );
  return {
    ...actual,
    deferBatchIfNotReady: () => null,
  };
});

vi.mock('../../src/lib/uicp/adapters/queue', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/uicp/adapters/queue')>('../../src/lib/uicp/adapters/queue');
  return {
    ...actual,
    enqueueBatch: vi.fn(async () => ({ success: true, applied: 1, errors: [], skippedDupes: 0 })),
  };
});

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
    
    // Should have logged error with E-UICP-301
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/E-UICP-301/),
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
    
    // Should have logged error with E-UICP-301
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/E-UICP-301/),
      expect.any(Error)
    );
    
    consoleErrorSpy.mockRestore();
    
    expect(vi.mocked(enqueueBatch)).not.toHaveBeenCalled();
  });
});
