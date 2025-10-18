import { describe, it, expect } from 'vitest';
import { buildComponentMarkup } from '../../src/lib/uicp/adapters/adapter.lifecycle';

describe('adapter component markup', () => {
  it('uses a neutral frame with no visible placeholder text for unknown components', () => {
    const html = buildComponentMarkup({
      id: 'cmp-x',
      type: 'unknown',
      props: {},
      windowId: 'win-x',
      target: '#root',
    } as any);
    expect(html.toLowerCase()).not.toContain('placeholder');
    expect(html).not.toMatch(/Prototype component/);
    // Neutral frame retains dashed border styling but no visible text content
    expect(html).toMatch(/border-dashed/);
    expect(html).toMatch(/>\s*<\/div>$/);
  });
});
