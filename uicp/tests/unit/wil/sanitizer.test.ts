import { describe, it, expect } from 'vitest';
import { parseWILBatch } from '../../../src/lib/orchestrator/parseWILBatch';

describe('WIL sanitizer', () => {
  it('drops prefaces and keeps WIL', () => {
    const text = `Sure, here you go:
create window title SmokeTest width 320 height 200`;
    const batch = parseWILBatch(text);
    expect(batch).toHaveLength(1);
    const only = batch[0] as { op: string; params: any };
    expect('op' in only && only.op).toBe('window.create');
    expect(only.params.title).toBe('SmokeTest');
  });

  it('forbids early nop: when ops follow', () => {
    const text = `nop: confused
create window title SmokeTest width 320 height 200`;
    const batch = parseWILBatch(text);
    expect(batch).toHaveLength(1);
    const only = batch[0] as { op: string; params: any };
    expect(only.op).toBe('window.create');
  });

  it('honors real nop: when it is the only line', () => {
    const text = `nop: blocked capability`;
    const batch = parseWILBatch(text);
    expect(batch).toHaveLength(1);
    expect('nop' in batch[0]).toBe(true);
  });

  it('extracts BEGIN/END WIL block', () => {
    const text = `Narration up here
BEGIN WIL
create window title Blocky width 320 height 200
END WIL
and stuff below`;
    const batch = parseWILBatch(text);
    expect(batch).toHaveLength(1);
    const only = batch[0] as { op: string; params: any };
    expect(only.op).toBe('window.create');
    expect(only.params.title).toBe('Blocky');
  });

  it('strips Kimi-K2 tool call markers and emit batch lines', () => {
    const text = `create window title Test width 320 height 200
replace html in "#root" of window win-test with "<div>Content</div>"
emit batch [{"batch":[{"type":"window","op":"create"}]}]
<|tool_call_end|>
<|tool_calls_section_end|>`;
    const batch = parseWILBatch(text);
    expect(batch).toHaveLength(2);
    expect(batch[0]).toMatchObject({ op: 'window.create' });
    expect(batch[1]).toMatchObject({ op: 'dom.replace' });
  });
});
