import { describe, it, expect, expectTypeOf } from 'vitest';
import { LEXICON } from '../../../src/lib/wil/lexicon';
import type { OperationNameT } from '../../../src/lib/uicp/schemas';
import { parseUtterance, matchTemplate, type Parsed } from '../../../src/lib/wil/parse';
import { toOp } from '../../../src/lib/wil/map';

function assertParsedOp<K extends OperationNameT>(parsed: Parsed | null, op: K): asserts parsed is Parsed<K> {
  expect(parsed).toBeTruthy();
  expect(parsed?.op).toBe(op);
  if (!parsed || parsed.op !== op) {
    throw new Error(`expected ${op}`);
  }
}

describe('LEXICON type coverage', () => {
  it('covers all OperationNameT keys', () => {
    expectTypeOf(LEXICON).toMatchTypeOf({} as Record<OperationNameT, any>);
  });
});

describe('parse + map basic flows', () => {
  it('parses and validates window.create with width/height', () => {
    const s = 'create window title "Notes" width 1200 height 800';
    const parsed = parseUtterance(s);
    assertParsedOp(parsed, 'window.create');
    const op = toOp(parsed);
    if (op.op !== 'window.create') {
      throw new Error('expected window.create');
    }
    expect(op.op).toBe('window.create');
    expect(op.params.title).toBe('Notes');
    expect(op.params.width).toBe(1200);
    expect(op.params.height).toBe(800);
  });

  it('parses api.call via open url', () => {
    const s = 'please open url https://example.com';
    const parsed = parseUtterance(s);
    assertParsedOp(parsed, 'api.call');
    const op = toOp(parsed);
    if (op.op !== 'api.call') {
      throw new Error('expected api.call');
    }
    expect(op.params.method).toBe('GET');
    expect(op.params.url).toBe('https://example.com');
  });

  it('template matcher accepts open url', () => {
    const m = matchTemplate('open url https://example.com', 'open url {url}');
    expect(m).toBeTruthy();
    expect(m!.url).toBe('https://example.com');
  });

  // additional robustness covered via parseUtterance
});
