import { describe, it, expect } from 'vitest';
import { extractEventsFromChunk, type StreamEvent } from '../llm.stream';

const contents = (evs: StreamEvent[]) => evs.filter((e): e is Extract<StreamEvent, { type: 'content' }> => e.type === 'content');
const calls = (evs: StreamEvent[]) => evs.filter((e): e is Extract<StreamEvent, { type: 'tool_call' }> => e.type === 'tool_call');

describe('StreamEvent v1 normalization contract (frontend extractor)', () => {
  it('OpenAI: choices[].delta.content string', () => {
    const chunk = { choices: [{ delta: { content: 'Hello' } }] };
    const evs = extractEventsFromChunk(chunk);
    expect(contents(evs)[0]?.text).toBe('Hello');
  });

  it('OpenAI: choices[].delta.content parts array', () => {
    const chunk = { choices: [{ delta: { content: [{ type: 'text', text: 'Hi' }, { type: 'text', text: ' there' }] } }] };
    const evs = extractEventsFromChunk(chunk);
    expect(contents(evs).map((e) => e.text).join('')).toBe('Hi there');
  });

  it('OpenAI: choices[].delta.tool_calls[] entries', () => {
    const chunk = { choices: [{ delta: { tool_calls: [{ index: 0, id: 't0', function: { name: 'emit_batch', arguments: '{"a":1}' } }] } }] };
    const evs = extractEventsFromChunk(chunk);
    const c = calls(evs)[0];
    expect(c?.index).toBe(0);
    expect(c?.id).toBe('t0');
    expect(c?.name).toBe('emit_batch');
    expect(c?.isDelta).toBe(true);
  });

  it('OpenAI: message.tool_calls (final message)', () => {
    const chunk = { message: { content: [{ type: 'text', text: 'ok' }], tool_calls: [{ id: 'x', function: { name: 'emit_batch', arguments: '{}' } }] } };
    const evs = extractEventsFromChunk(chunk);
    expect(contents(evs)[0]?.text).toBe('ok');
    expect(calls(evs)[0]?.name).toBe('emit_batch');
  });

  it('Root-level tool_calls array', () => {
    const chunk = { tool_calls: [{ function: { name: 'emit_batch', arguments: '{}' } }] };
    const evs = extractEventsFromChunk(chunk);
    expect(calls(evs)).toHaveLength(1);
  });

  it('Root-level content object/value', () => {
    const chunk = { content: [{ type: 'text', text: 'A' }] };
    const evs = extractEventsFromChunk(chunk);
    expect(contents(evs)[0]?.text).toBe('A');
  });
});
