import { describe, it, expect } from 'vitest';
import { sanitizeHtml } from '../../utils';
import { validateBatch } from '../schemas';

describe('sanitizeHtml', () => {
  it('removes <script> and <style> blocks', () => {
    const input = '<div>ok</div><script>alert(1)</script><style>.x{}</style>';
    const out = sanitizeHtml(input);
    expect(out).toBe('<div>ok</div>');
  });

  it('neutralizes inline event handlers', () => {
    const input = '<button onclick="steal()">x</button>';
    const out = sanitizeHtml(input);
    expect(out.toLowerCase()).not.toContain('onclick=');
    expect(out).toContain('data-attr=');
  });

  it('blocks javascript: URLs (case/space variants)', () => {
    const input = '<a href="  JaVaScRiPt:alert(1) ">x</a>';
    const out = sanitizeHtml(input);
    expect(/javascript:/i.test(out)).toBe(false);
    expect(out).toMatch(/href=("|')#\1/);
  });

  it('removes dangerous container elements and svg foreignObject', () => {
    const input = '<iframe src="https://x"></iframe><svg><foreignObject></foreignObject></svg>';
    const out = sanitizeHtml(input);
    expect(out).toBe('<svg></svg>');
  });

  it('allows safe https/http and data:image URLs but blocks others', () => {
    const good = '<img src="https://example.com/x.png"><img src="http://e/x.png"><img src="data:image/png;base64,AAAA">';
    const bad = '<form action="file:///etc/passwd">';
    expect(sanitizeHtml(good)).toBe(good);
    const sanitizedBad = sanitizeHtml(bad);
    expect(sanitizedBad).not.toContain('file:///');
    expect(sanitizedBad).toMatch(/action=("|')#\1/);
  });
});

describe('validateBatch HTML guardrails', () => {
  it('rejects unsafe HTML in dom.set at validation time', () => {
    const batch = [
      {
        op: 'dom.set',
        params: { windowId: 'win-a', target: '#root', html: '<div onclick="x()">bad</div>' },
      },
    ];
    expect(() => validateBatch(batch)).toThrowError();
  });
});
