import { describe, it, expect } from 'vitest';
import { buildComponentMarkup } from '../../src/lib/uicp/adapters/adapter.lifecycle';

describe('adapter component markup', () => {
  it('does not contain placeholder wording in default markup', () => {
    const html = buildComponentMarkup({
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

