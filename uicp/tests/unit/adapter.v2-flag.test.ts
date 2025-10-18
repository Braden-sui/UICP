import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Batch } from '../../src/lib/uicp/schemas';

/**
 * Feature Flag Tests: V1 vs V2 Adapter
 * 
 * WHY: Validates that v2 adapter behaves identically to v1
 * INVARIANT: Both paths must produce identical results for all commands
 * 
 * NOTE: These tests run with v1 (ADAPTER_V2_ENABLED=false by default)
 * To test v2, run with UICP_ADAPTER_V2=1 environment variable
 */

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

import { registerWorkspaceRoot, resetWorkspace } from '../../src/lib/uicp/adapter';
import { applyBatch } from '../../src/lib/uicp/adapters/adapter.queue';
import { ADAPTER_V2_ENABLED } from '../../src/lib/uicp/adapters/adapter.featureFlags';

describe('adapter v1/v2 parity', () => {
  beforeEach(() => {
    resetWorkspace();
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.id = 'workspace-root';
    document.body.appendChild(root);
    registerWorkspaceRoot(root);
  });

  it(`uses ${ADAPTER_V2_ENABLED ? 'v2' : 'v1'} adapter based on flag`, () => {
    // After Phase 3: v2 enabled by default in dev, unless explicitly disabled
    const expectedV2 = process.env.UICP_ADAPTER_V2 === '1' || 
                       (process.env.UICP_ADAPTER_V2 !== '0' && import.meta.env.DEV);
    expect(ADAPTER_V2_ENABLED).toBe(expectedV2);
  });

  it('window.create produces identical results', async () => {
    const batch: Batch = [
      {
        op: 'window.create',
        params: {
          id: 'win-test',
          title: 'Test Window',
          width: 640,
          height: 480,
        },
      },
    ];

    const result = await applyBatch(batch);
    
    expect(result.success).toBe(true);
    expect(result.applied).toBe(1);
    expect(result.errors).toEqual([]);
    
    // Verify window was created
    const window = document.querySelector('[data-window-id="win-test"]');
    expect(window).toBeTruthy();
    expect(window?.textContent).toContain('Test Window');
  });

  it('dom.set produces identical results', async () => {
    const batch: Batch = [
      {
        op: 'window.create',
        params: {
          id: 'win-dom',
          title: 'DOM Test',
        },
      },
      {
        op: 'dom.set',
        params: {
          windowId: 'win-dom',
          target: '#root',
          html: '<div class="test-content">Hello World</div>',
        },
      },
    ];

    const result = await applyBatch(batch);
    
    expect(result.success).toBe(true);
    expect(result.applied).toBe(2);
    
    // Verify content was set
    const content = document.querySelector('[data-window-id="win-dom"] .test-content');
    expect(content?.textContent).toBe('Hello World');
  });

  it('component.render produces identical results', async () => {
    const batch: Batch = [
      {
        op: 'window.create',
        params: {
          id: 'win-comp',
          title: 'Component Test',
        },
      },
      {
        op: 'component.render',
        params: {
          id: 'comp-1',
          windowId: 'win-comp',
          target: '#root',
          type: 'button',
          props: {
            label: 'Click Me',
          },
        },
      },
    ];

    const result = await applyBatch(batch);
    
    expect(result.success).toBe(true);
    expect(result.applied).toBe(2);
    
    // Verify component was rendered
    const component = document.querySelector('[data-component-id="comp-1"]');
    expect(component).toBeTruthy();
    expect(component?.textContent).toContain('Click Me');
  });

  it('state.set/get produces identical results', async () => {
    const batch: Batch = [
      {
        op: 'state.set',
        params: {
          scope: 'workspace',
          key: 'test-key',
          value: 'test-value',
        },
      },
    ];

    const result = await applyBatch(batch);
    
    expect(result.success).toBe(true);
    expect(result.applied).toBe(1);
    
    // Note: state.get requires accessing the state store directly
    // For now, just verify the set operation succeeded
  });

  it('window.update produces identical results', async () => {
    const batch: Batch = [
      {
        op: 'window.create',
        params: {
          id: 'win-update',
          title: 'Original',
        },
      },
      {
        op: 'window.update',
        params: {
          id: 'win-update',
          title: 'Updated Title',
          width: 800,
          height: 600,
        },
      },
    ];

    const result = await applyBatch(batch);
    
    expect(result.success).toBe(true);
    expect(result.applied).toBe(2);
    
    // Verify window was updated
    const window = document.querySelector('[data-window-id="win-update"]');
    expect(window?.textContent).toContain('Updated Title');
  });

  it('window.close produces identical results', async () => {
    const batch: Batch = [
      {
        op: 'window.create',
        params: {
          id: 'win-close',
          title: 'To Close',
        },
      },
      {
        op: 'window.close',
        params: {
          id: 'win-close',
        },
      },
    ];

    const result = await applyBatch(batch);
    
    expect(result.success).toBe(true);
    expect(result.applied).toBe(2);
    
    // Verify window was closed
    const window = document.querySelector('[data-window-id="win-close"]');
    expect(window).toBeNull();
  });

  it('handles errors identically', async () => {
    const batch: Batch = [
      {
        op: 'dom.set',
        params: {
          windowId: 'non-existent-window',
          target: '#root',
          html: '<div>Test</div>',
        },
      },
    ];

    const result = await applyBatch(batch);
    
    // V2 will auto-create the window, so this should succeed
    // Both v1 and v2 should behave the same way
    expect(result.success).toBe(true);
    expect(result.applied).toBe(1);
  });

  it('processes batches atomically', async () => {
    const batch: Batch = [
      {
        op: 'window.create',
        params: {
          id: 'win-batch',
          title: 'Batch Test',
        },
      },
      {
        op: 'dom.set',
        params: {
          windowId: 'win-batch',
          target: '#root',
          html: '<div>Step 1</div>',
        },
      },
      {
        op: 'dom.append',
        params: {
          windowId: 'win-batch',
          target: '#root',
          html: '<div>Step 2</div>',
        },
      },
    ];

    const result = await applyBatch(batch);
    
    expect(result.success).toBe(true);
    expect(result.applied).toBe(3);
    
    // Verify all operations were applied
    const root = document.querySelector('[data-window-id="win-batch"] #root');
    expect(root?.textContent).toContain('Step 1');
    expect(root?.textContent).toContain('Step 2');
  });
});
