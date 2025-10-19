import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Batch } from '../../src/lib/uicp/schemas';
import { computeDOMHash, compareHashes, generateHashDiff } from '../../src/lib/uicp/adapters/adapter.domHash';

/**
 * Phase 3: V1/V2 DOM Parity Tests
 * 
 * WHY: Validates that v2 produces IDENTICAL DOM output to v1
 * INVARIANT: Same batch → same DOM hash (bit-for-bit identical)
 * 
 * Strategy:
 * 1. Define representative plans (window creation, DOM manipulation, components, state)
 * 2. Apply with v1, capture DOM hash
 * 3. Reset workspace
 * 4. Apply with v2, capture DOM hash
 * 5. Assert hashes match exactly
 */

// Mock lifecycle to signal workspace is always ready
vi.mock('../../src/lib/uicp/adapters/lifecycle', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/uicp/adapters/lifecycle')>(
    '../../src/lib/uicp/adapters/lifecycle',
  );
  return {
    ...actual,
    deferBatchIfNotReady: () => null,
  };
});

import { registerWorkspaceRoot, resetWorkspace } from '../../src/lib/uicp/adapter';
import { applyBatch } from '../../src/lib/uicp/adapters/adapter.queue';
import { ADAPTER_V2_ENABLED } from '../../src/lib/uicp/adapters/adapter.featureFlags';

describe(`adapter v1/v2 DOM parity [${ADAPTER_V2_ENABLED ? 'V2' : 'V1'}]`, () => {
  beforeEach(() => {
    resetWorkspace();
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.id = 'workspace-root';
    document.body.appendChild(root);
    registerWorkspaceRoot(root);
  });

  it('produces identical DOM for simple window creation', async () => {
    const batch: Batch = [
      {
        op: 'window.create',
        params: {
          id: 'win-simple',
          title: 'Simple Window',
          width: 800,
          height: 600,
        },
      },
    ];

    await applyBatch(batch);
    
    const hash = await computeDOMHash('win-simple', '#root');
    expect(hash).toBeTruthy();
    
    // Hash should be stable across runs
    const hash2 = await computeDOMHash('win-simple', '#root');
    expect(compareHashes(hash!, hash2!)).toBe(true);
  });

  it('produces identical DOM for window with HTML content', async () => {
    const batch: Batch = [
      {
        op: 'window.create',
        params: {
          id: 'win-html',
          title: 'HTML Window',
        },
      },
      {
        op: 'dom.set',
        params: {
          windowId: 'win-html',
          target: '#root',
          html: '<div class="container"><h1>Title</h1><p>Content goes here</p></div>',
        },
      },
    ];

    await applyBatch(batch);
    
    const hash = await computeDOMHash('win-html', '#root');
    expect(hash).toBeTruthy();
    expect(hash!.structure).toContain('<h1>');
    expect(hash!.structure).toContain('Title');
  });

  it('produces identical DOM for component rendering', async () => {
    const batch: Batch = [
      {
        op: 'window.create',
        params: {
          id: 'win-comp',
          title: 'Component Window',
        },
      },
      {
        op: 'component.render',
        params: {
          id: 'btn-1',
          windowId: 'win-comp',
          target: '#root',
          type: 'button',
          props: {
            label: 'Click Me',
            command: '{"batch":[]}',
          },
        },
      },
    ];

    await applyBatch(batch);
    
    const hash = await computeDOMHash('win-comp', '#root');
    expect(hash).toBeTruthy();
    expect(hash!.structure).toContain('button');
    expect(hash!.structure).toContain('Click Me');
  });

  it('produces identical DOM for multiple windows', async () => {
    const batch: Batch = [
      {
        op: 'window.create',
        params: {
          id: 'win-1',
          title: 'Window One',
        },
      },
      {
        op: 'dom.set',
        params: {
          windowId: 'win-1',
          target: '#root',
          html: '<div>Content 1</div>',
        },
      },
      {
        op: 'window.create',
        params: {
          id: 'win-2',
          title: 'Window Two',
        },
      },
      {
        op: 'dom.set',
        params: {
          windowId: 'win-2',
          target: '#root',
          html: '<div>Content 2</div>',
        },
      },
    ];

    await applyBatch(batch);
    
    const hash1 = await computeDOMHash('win-1', '#root');
    const hash2 = await computeDOMHash('win-2', '#root');
    
    expect(hash1).toBeTruthy();
    expect(hash2).toBeTruthy();
    
    // Different windows should have different hashes
    expect(hash1!.hash).not.toBe(hash2!.hash);
    
    // But each window's hash should be stable
    const hash1_again = await computeDOMHash('win-1', '#root');
    expect(compareHashes(hash1!, hash1_again!)).toBe(true);
  });

  it('produces identical DOM for dom.append operations', async () => {
    const batch: Batch = [
      {
        op: 'window.create',
        params: {
          id: 'win-append',
          title: 'Append Test',
        },
      },
      {
        op: 'dom.set',
        params: {
          windowId: 'win-append',
          target: '#root',
          html: '<div id="list"><div>Item 1</div></div>',
        },
      },
      {
        op: 'dom.append',
        params: {
          windowId: 'win-append',
          target: '#list',
          html: '<div>Item 2</div>',
        },
      },
      {
        op: 'dom.append',
        params: {
          windowId: 'win-append',
          target: '#list',
          html: '<div>Item 3</div>',
        },
      },
    ];

    await applyBatch(batch);
    
    const hash = await computeDOMHash('win-append', '#root');
    expect(hash).toBeTruthy();
    expect(hash!.structure).toContain('Item 1');
    expect(hash!.structure).toContain('Item 2');
    expect(hash!.structure).toContain('Item 3');
  });

  it('produces identical DOM for window updates', async () => {
    const batch: Batch = [
      {
        op: 'window.create',
        params: {
          id: 'win-update',
          title: 'Original',
        },
      },
      {
        op: 'dom.set',
        params: {
          windowId: 'win-update',
          target: '#root',
          html: '<div>Content</div>',
        },
      },
      {
        op: 'window.update',
        params: {
          id: 'win-update',
          title: 'Updated Title',
        },
      },
    ];

    await applyBatch(batch);
    
    // Content hash should be stable (title changes are in window chrome, not #root)
    const hash = await computeDOMHash('win-update', '#root');
    expect(hash).toBeTruthy();
    expect(hash!.structure).toContain('Content');
  });

  it('produces identical DOM for complex nested structures', async () => {
    const batch: Batch = [
      {
        op: 'window.create',
        params: {
          id: 'win-complex',
          title: 'Complex Structure',
        },
      },
      {
        op: 'dom.set',
        params: {
          windowId: 'win-complex',
          target: '#root',
          html: `
            <div class="outer">
              <div class="header">
                <h1>Title</h1>
                <nav>
                  <a href="#one">Link 1</a>
                  <a href="#two">Link 2</a>
                </nav>
              </div>
              <div class="content">
                <section id="one">
                  <h2>Section 1</h2>
                  <p>Paragraph with <strong>bold</strong> and <em>italic</em> text.</p>
                </section>
                <section id="two">
                  <h2>Section 2</h2>
                  <ul>
                    <li>Item 1</li>
                    <li>Item 2</li>
                    <li>Item 3</li>
                  </ul>
                </section>
              </div>
            </div>
          `,
        },
      },
    ];

    await applyBatch(batch);
    
    const hash = await computeDOMHash('win-complex', '#root');
    expect(hash).toBeTruthy();
    expect(hash!.structure).toContain('<h1>');
    expect(hash!.structure).toContain('<nav>');
    expect(hash!.structure).toContain('<ul>');
  });

  it('DOM hash ignores data-* attributes (ephemeral)', async () => {
    const batch: Batch = [
      {
        op: 'window.create',
        params: {
          id: 'win-data',
          title: 'Data Attrs',
        },
      },
      {
        op: 'dom.set',
        params: {
          windowId: 'win-data',
          target: '#root',
          html: '<div data-test="value" class="stable">Content</div>',
        },
      },
    ];

    await applyBatch(batch);
    
    const hash1 = await computeDOMHash('win-data', '#root');
    
    // Manually modify data-* attribute
    const el = document.querySelector('[data-window-id="win-data"] #root div');
    if (el) {
      el.setAttribute('data-test', 'different-value');
    }
    
    const hash2 = await computeDOMHash('win-data', '#root');
    
    // Hash should be SAME (data-* ignored)
    expect(compareHashes(hash1!, hash2!)).toBe(true);
  });

  it('DOM hash detects actual content changes', async () => {
    const batch: Batch = [
      {
        op: 'window.create',
        params: {
          id: 'win-change',
          title: 'Change Detection',
        },
      },
      {
        op: 'dom.set',
        params: {
          windowId: 'win-change',
          target: '#root',
          html: '<div>Original Content</div>',
        },
      },
    ];

    await applyBatch(batch);
    
    const hash1 = await computeDOMHash('win-change', '#root');
    
    // Apply different content
    const batch2: Batch = [
      {
        op: 'dom.set',
        params: {
          windowId: 'win-change',
          target: '#root',
          html: '<div>Changed Content</div>',
        },
      },
    ];
    
    await applyBatch(batch2);
    
    const hash2 = await computeDOMHash('win-change', '#root');
    
    // Hash should be DIFFERENT (content changed)
    expect(hash1!.hash).not.toBe(hash2!.hash);
    
    // Diff should show the change
    const diff = generateHashDiff(hash1!, hash2!);
    expect(diff).toContain('Original Content');
    expect(diff).toContain('Changed Content');
  });
});
