import { describe, it, expect } from 'vitest';
import { HarmonyDecoder } from '../../src/lib/llm/parsers/oss-harmony';

const collect = (decoder: HarmonyDecoder, chunk: string) => Array.from(decoder.push(chunk));

describe('HarmonyDecoder', () => {
  it('parses tool call split across chunks', () => {
    const decoder = new HarmonyDecoder();
    const first = collect(decoder, '<|start|><|channel|>final<|call|>window.create {"ti');
    const second = collect(decoder, 'tle":"Notes"}<|end|>');
    const merged = [...first, ...second];
    const tool = merged.find((event) => event.type === 'tool');
    expect(tool).toBeDefined();
    expect(tool?.name).toBe('window.create');
    expect(tool && tool.type === 'tool' ? tool.args : undefined).toEqual({ title: 'Notes' });
  });

  it('emits analysis text without throwing', () => {
    const decoder = new HarmonyDecoder();
    const events = collect(
      decoder,
      '<|start|><|channel|>analysis<|message|>think think<|return|>{"ignored":true}<|end|>',
    );
    const textEvents = events.filter((event) => event.type === 'text');
    expect(textEvents.length).toBeGreaterThan(0);
  });

  it('coerces trailing commas and code fences', () => {
    const decoder = new HarmonyDecoder();
    const events = collect(
      decoder,
      '<|start|><|channel|>final<|call|>component.render ```json\n{"kind":"List",}\n``` <|end|>',
    );
    const tool = events.find((event) => event.type === 'tool');
    expect(tool && tool.type === 'tool' ? tool.args : undefined).toEqual({ kind: 'List' });
  });
});
