import { describe, it, expect } from 'vitest';
import { sanitizeHtml } from '../utils';
import { validateBatch, UICPValidationError } from '../uicp/schemas';

describe('HTML sanitizer and validation', () => {
  it('sanitizeHtml removes scripts, on* handlers, and javascript: URLs', () => {
    const dirty = `<script>alert('x')</script><div onclick="do()">ok</div><a href="javascript:alert(1)">x</a>`;
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toMatch(/onclick=/i);
    expect(clean).toMatch(/data-attr=/); // inline handlers are neutralized
    expect(clean).not.toMatch(/javascript:/i);
  });

  it('validateBatch rejects unsafe HTML in dom.set params', () => {
    const batch = [
      {
        op: 'dom.set',
        windowId: 'win-test',
        params: {
          windowId: 'win-test',
          target: '#root',
          html: '<div onclick="evil()">bad</div>',
        },
      },
    ];
    expect(() => validateBatch(batch)).toThrowError(UICPValidationError);
    try {
      validateBatch(batch);
    } catch (err) {
      const e = err as UICPValidationError;
      expect(e.pointer).toContain('/params/html');
      expect(e.message).toMatch(/disallowed content/i);
    }
  });
});
