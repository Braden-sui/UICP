import { describe, it, expect } from 'vitest';
import { parseUtterance } from '../../../src/lib/wil/parse';
import { toOp } from '../../../src/lib/wil/map';
import { validateBatch } from '../../../src/lib/uicp/schemas';

describe('WIL extra templates', () => {
  it('parses move window to x,y', () => {
    const p = parseUtterance('move window w1 to 120,80');
    expect(p && p.op).toBe('window.move');
    const op = toOp(p!);
    const batch = validateBatch([op]);
    const env = batch[0];
    expect(env.op).toBe('window.move');
    expect((env.params as any).id).toBe('w1');
    expect((env.params as any).x).toBe(120);
    expect((env.params as any).y).toBe(80);
  });

  it('parses resize window to WxH', () => {
    const p = parseUtterance('resize window w1 to 800x600');
    expect(p && p.op).toBe('window.resize');
    const op = toOp(p!);
    const batch = validateBatch([op]);
    const env = batch[0];
    expect((env.params as any).width).toBe(800);
    expect((env.params as any).height).toBe(600);
  });

  it('parses component mount with props', () => {
    const p = parseUtterance('render component panel in window w1 at #root with {"x":1}');
    expect(p && p.op).toBe('component.render');
    const op = toOp(p!);
    const batch = validateBatch([op]);
    const env = batch[0];
    expect((env.params as any).type).toBe('panel');
    expect((env.params as any).windowId).toBe('w1');
    expect((env.params as any).target).toBe('#root');
    expect((env.params as any).props).toEqual({ x: 1 });
  });

  it('parses swap html in target with window id', () => {
    const p = parseUtterance('swap html in "#root" of window w1 with "<div>Hi</div>"');
    expect(p && (p.op === 'dom.replace' || p.op === 'dom.set')).toBe(true);
    const op = toOp(p!);
    const batch = validateBatch([op]);
    const env = batch[0];
    expect((env.params as any).windowId).toBe('w1');
    expect((env.params as any).target).toBe('#root');
    expect((env.params as any).html).toContain('Hi');
  });
});

