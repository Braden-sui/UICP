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
    expect(out).toBe('<button>x</button>');
  });

  it('blocks javascript: URLs (case/space variants)', () => {
    const input = '<a href="  JaVaScRiPt:alert(1) ">x</a>';
    const out = sanitizeHtml(input);
    expect(out).toBe('<a>x</a>');
  });

  it('removes dangerous container elements and svg foreignObject', () => {
    const input = '<iframe src="https://x"></iframe><svg><foreignObject></foreignObject></svg>';
    const out = sanitizeHtml(input);
    expect(out).toBe('');
  });

  it('allows safe http(s) and relative URLs but removes data URIs', () => {
    const good = '<img src="https://example.com/x.png"><img src="http://e/x.png"><img src="/assets/foo.png"><a href="notes/today.html">notes</a>';
    expect(sanitizeHtml(good)).toBe(good);

    const dataImg = '<img src="data:image/png;base64,AAAA">';
    expect(sanitizeHtml(dataImg)).toBe('<img>');
  });

  it('drops svg-specific attack surface such as xlink:href', () => {
    const payload = '<svg><use xlink:href="javascript:alert(1)"></use></svg>';
    expect(sanitizeHtml(payload)).toBe('');
  });

  it('strips target=_blank to avoid opener vulnerabilities', () => {
    const input = '<a href="https://example.com" target="_blank">Open</a>';
    const out = sanitizeHtml(input);
    expect(out).toBe('<a href="https://example.com">Open</a>');
  });

  it('removes forms and unsafe actions entirely', () => {
    const input = '<form action="https://evil.test"><input type="text" name="x"></form>';
    expect(sanitizeHtml(input)).toBe('');
  });

  it('filters unsafe srcset entries', () => {
    const input = '<img srcset="https://cdn.example.com/a.png 1x, javascript:alert(1) 2x, /assets/img@3x.png 3x">';
    const out = sanitizeHtml(input);
    expect(out).toBe('<img srcset="https://cdn.example.com/a.png 1x, /assets/img@3x.png 3x">');
  });

  it('preserves safe ids and classes', () => {
    const input = '<div id="note-card" class="card highlight">Note</div>';
    const out = sanitizeHtml(input);
    expect(out).toBe('<div class="card highlight" id="note-card">Note</div>');
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
