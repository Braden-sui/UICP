import { describe, it, expect } from 'vitest';
import { installWorkspaceArtifactCleanup } from '../../src/lib/uicp/cleanup';

// WHY: Verify DOM cleanup heuristics after fixes to regex handling.
// INVARIANT: Cleanup should not throw; it should remove obvious artifact nodes and normalize attributes.

describe('workspace artifact cleanup', () => {
  it('removes adjacent bracket artifact text nodes and recovers data-command JSON', () => {
    const root = document.createElement('div');

    // Leading artifact-only text node simulating leaked JSON tail.
    root.appendChild(document.createTextNode("\"'}}])"));

    // Element with a broken data-command value that should be recoverable.
    const btn = document.createElement('button');
    // Single quotes, unquoted bareword value, and trailing comma
    btn.setAttribute('data-command', "{'action':'state.set', 'value':playing,}");
    btn.textContent = 'Run';
    root.appendChild(btn);

    const off = installWorkspaceArtifactCleanup(root);
    try {
      // Initial pass is synchronous; verify the artifact node is gone.
      expect(root.firstChild).toBe(btn);

      const fixed = btn.getAttribute('data-command');
      expect(fixed).toBeTruthy();
      expect(fixed).not.toBe("{'action':'state.set', 'value':playing,");
      // Must parse as valid JSON after recovery.
      const parsed = JSON.parse(fixed!);
      expect(parsed).toMatchObject({ action: 'state.set', value: 'playing' });
    } finally {
      off();
    }
  });

  it('trims suspicious JSON fragments from label text', () => {
    const root = document.createElement('div');
    const a = document.createElement('a');
    a.setAttribute('data-command', '{"ok":true}');
    a.appendChild(document.createTextNode('Open {"debug":true} now'));
    root.appendChild(a);

    const off = installWorkspaceArtifactCleanup(root);
    try {
      // Label should be trimmed before the JSON-looking fragment.
      expect(a.textContent).toBe('Open');
    } finally {
      off();
    }
  });
});

