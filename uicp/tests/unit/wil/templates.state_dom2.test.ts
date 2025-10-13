import { describe, it, expect } from 'vitest';
import { parseUtterance } from '../../../src/lib/wil/parse';
import { toOp } from '../../../src/lib/wil/map';
import { validateBatch } from '../../../src/lib/uicp/schemas';

describe('WIL extended templates for DOM/Component/State', () => {
  it('parses add to target with window id', () => {
    const p = parseUtterance('add to #items of window win-1 <li>Row</li>');
    expect(p).not.toBeNull();
    const op = toOp(p!);
    const batch = validateBatch([op]);
    const env = batch[0];
    expect(['dom.append', 'dom.set', 'dom.replace']).toContain(env.op);
    expect((env.params as any).windowId).toBe('win-1');
    expect((env.params as any).target).toBe('#items');
  });

  it('parses patch component with props', () => {
    const p = parseUtterance('patch component c-1 with {"visible":true}');
    expect(p && p.op).toBe('component.update');
    const op = toOp(p!);
    const batch = validateBatch([op]);
    const env = batch[0];
    expect((env.params as any).id).toBe('c-1');
    expect((env.params as any).props).toEqual({ visible: true });
  });

  it('parses append using "append to" with quoted fields', () => {
    const p = parseUtterance("append to '#items' of window 'win-2' <li>Row</li>");
    expect(p && ['dom.append', 'dom.set', 'dom.replace'].includes(p.op)).toBe(true);
    const op = toOp(p!);
    const batch = validateBatch([op]);
    const env = batch[0];
    expect((env.params as any).windowId).toBe('win-2');
    expect((env.params as any).target).toBe('#items');
  });

  it('parses set inner html variant to dom.set', () => {
    const p = parseUtterance("set inner html in #main of window win-3 to <div>Hi</div>");
    expect(p && p.op).toBe('dom.set');
    const op = toOp(p!);
    const batch = validateBatch([op]);
    const env = batch[0];
    expect((env.params as any).windowId).toBe('win-3');
    expect((env.params as any).target).toBe('#main');
  });

  it('parses set component props variant', () => {
    const p = parseUtterance("set component c-9 props {\"visible\":false}");
    expect(p && p.op).toBe('component.update');
    const op = toOp(p!);
    const batch = validateBatch([op]);
    const env = batch[0];
    expect((env.params as any).id).toBe('c-9');
    expect((env.params as any).props).toEqual({ visible: false });
  });

  it('parses change component with quoted id and props', () => {
    const p = parseUtterance("change component 'c-7' props to {\"count\":3}");
    expect(p && p.op).toBe('component.update');
    const env = validateBatch([toOp(p!)])[0];
    expect((env.params as any).id).toBe('c-7');
    expect((env.params as any).props).toEqual({ count: 3 });
  });

  it('parses update component with {props}', () => {
    const p = parseUtterance("update component c-12 with {\"name\":\"x\"}");
    expect(p && p.op).toBe('component.update');
    const env = validateBatch([toOp(p!)])[0];
    expect((env.params as any).id).toBe('c-12');
    expect((env.params as any).props).toEqual({ name: 'x' });
  });

  it('parses add {html} to {target} with windowId', () => {
    const p2 = parseUtterance("add <li>A</li> to #list of window w1");
    expect(p2 && ['dom.append','dom.set','dom.replace'].includes(p2.op)).toBe(true);
    const op2 = toOp(p2!);
    const env2 = validateBatch([op2])[0];
    expect((env2.params as any).target).toBe('#list');
    expect((env2.params as any).windowId).toBe('w1');
  });

  it('parses dom.set with bracket selector and quoted attribute', () => {
    const p = parseUtterance('set html in [data-test="panel"] of window win-1 to <div>OK</div>');
    expect(p && p.op).toBe('dom.set');
    const env = validateBatch([toOp(p!)])[0];
    expect((env.params as any).target).toBe('[data-test="panel"]');
    expect((env.params as any).windowId).toBe('win-1');
  });

  it('parses dom.append with quoted selector', () => {
    const p = parseUtterance('append to "[data-role=items]" of window w2 <li>R</li>');
    expect(p && ['dom.append','dom.set','dom.replace'].includes(p.op)).toBe(true);
    const env = validateBatch([toOp(p!)])[0];
    expect((env.params as any).target).toBe('[data-role=items]');
    expect((env.params as any).windowId).toBe('w2');
  });

  it('parses dom.replace with quoted selector and windowId', () => {
    const p = parseUtterance('replace html in "[data-id=slot]" of window w-3 with <span>OK</span>');
    expect(p && p.op).toBe('dom.replace');
    const env = validateBatch([toOp(p!)])[0];
    expect((env.params as any).target).toBe('[data-id=slot]');
    expect((env.params as any).windowId).toBe('w-3');
  });
});
