import { describe, it, expect } from 'vitest';
import { sanitizeHtmlStrict, escapeHtml } from './adapter.security';

describe('adapter.security sanitization', () => {
  it('sanitizes risky HTML content deterministically', () => {
    const input = `<div class="payload"><script>alert('xss')</script><img src="javascript:evil" onerror="hack()" /><p data-trusted="yes">Hello</p></div>`;
    const sanitized = sanitizeHtmlStrict(input);
    expect(sanitized).toMatchInlineSnapshot(`"<div class="payload"><img><p>Hello</p></div>"`);
  });

  it('escapes HTML entities consistently', () => {
    const escaped = escapeHtml(`<div data-test="value">He said "hello" & left</div>`);
    expect(escaped).toMatchInlineSnapshot(`"&lt;div data-test=&quot;value&quot;&gt;He said &quot;hello&quot; &amp; left&lt;/div&gt;"`);
  });
});
