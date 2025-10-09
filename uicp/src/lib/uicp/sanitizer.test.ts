import { describe, it, expect } from 'vitest';
import { sanitizeHtml } from '../utils';
import { validateBatch } from './schemas';

const mkDomSet = (html: string) => ([{
  op: 'dom.set',
  params: { windowId: 'win-test', target: '#root', html },
}] as const);

describe('sanitizeHtml', () => {
  it('removes <script> and <style> blocks', () => {
    const input = '<div>a</div><script>alert(1)</script><style>body{}</style>';
    const out = sanitizeHtml(input);
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/<style/i);
  });

  it('neutralizes inline event handlers and javascript: URLs', () => {
    const input = '<a href=" javascript:alert(1) " onclick="x=1">x</a>';
    const out = sanitizeHtml(input);
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toMatch(/onclick=/i);
    expect(out).toMatch(/href="#"/);
  });

  it('blocks dangerous containers and svg foreignObject', () => {
    const input = '<iframe src="about:blank"></iframe><svg><foreignObject>bad</foreignObject></svg>';
    const out = sanitizeHtml(input);
    expect(out).not.toMatch(/<iframe/i);
    expect(out).toBe('<svg></svg>');
  });
});

describe('validateBatch HTML safety and budgets', () => {
  it('rejects unsafe HTML via schema superRefine', () => {
    const batch = mkDomSet('<a href="javascript:evil()">x</a>');
    expect(() => validateBatch(batch)).toThrowError();
  });

  it('enforces per-op 64KB html limit', () => {
    const big = 'x'.repeat(64 * 1024 + 1);
    const batch = mkDomSet(big);
    expect(() => validateBatch(batch)).toThrowError();
  });

  it('enforces total HTML budget 128KB per batch', () => {
    const chunk = 'x'.repeat(64 * 1024);
    const batch = [
      ...mkDomSet(chunk),
      ...mkDomSet(chunk),
    ];
    // total = 128KB exactly: should be OK
    expect(() => validateBatch(batch)).not.toThrowError();

    const batchTooBig = [
      ...mkDomSet(chunk),
      ...mkDomSet(chunk + 'x'),
    ];
    expect(() => validateBatch(batchTooBig)).toThrowError();
  });
});
