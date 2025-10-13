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
});
