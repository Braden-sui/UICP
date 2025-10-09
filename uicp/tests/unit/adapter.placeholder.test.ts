import { describe, it, expect } from 'vitest';
import { buildComponentMarkupForTest } from '../../src/lib/uicp/adapter';

describe('adapter component markup', () => {
  it('does not contain placeholder wording in default markup', () => {
    const html = buildComponentMarkupForTest({
      id: 'cmp-x',
      type: 'unknown',
      props: {},
      windowId: 'win-x',
      target: '#root',
    } as any);
    expect(html.toLowerCase()).not.toContain('placeholder');
    expect(html).toMatch(/Prototype component/);
  });
});

