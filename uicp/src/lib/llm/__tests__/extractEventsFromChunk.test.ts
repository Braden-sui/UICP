import { describe, it, expect } from 'vitest';
import { extractEventsFromChunk, type StreamEvent } from '../llm.stream';

const getContent = (events: StreamEvent[]): Extract<StreamEvent, { type: 'content' }>[] =>
  events.filter((e): e is Extract<StreamEvent, { type: 'content' }> => e.type === 'content');

const getToolCalls = (events: StreamEvent[]): Extract<StreamEvent, { type: 'tool_call' }>[] =>
  events.filter((e): e is Extract<StreamEvent, { type: 'tool_call' }> => e.type === 'tool_call');

describe('extractEventsFromChunk', () => {
  it('extracts simple OpenAI delta content (string)', () => {
    const v = { choices: [{ delta: { content: 'Hello' } }] };
    const events = extractEventsFromChunk(v);
    const contents = getContent(events);
    expect(contents).toHaveLength(1);
    expect(contents[0]!.text).toBe('Hello');
    expect(contents[0]!.channel).toBeUndefined();
  });

  it('extracts array content parts with text objects', () => {
    const v = { choices: [{ delta: { content: [{ type: 'text', text: 'Hi' }, { type: 'text', text: ' there' }] } }] };
    const events = extractEventsFromChunk(v);
    const text = getContent(events).map((e: Extract<StreamEvent, { type: 'content' }>) => e.text).join('');
    expect(text).toBe('Hi there');
  });

  it('extracts tool_call deltas from delta.tool_calls', () => {
    const v = { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'foo', arguments: '{"a":1}' } }] } }] };
    const events = extractEventsFromChunk(v);
    const calls = getToolCalls(events);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.index).toBe(0);
    expect(calls[0]!.name).toBe('foo');
    expect(calls[0]!.arguments).toBe('{"a":1}');
  });

  it('extracts tool_call delta from single delta.tool_call object', () => {
    const v = { choices: [{ delta: { tool_call: { id: 'x', function: { name: 'bar', arguments: '{}' } } } }] } as const;
    const events = extractEventsFromChunk(v);
    const calls = getToolCalls(events);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe('x');
    expect(calls[0]!.name).toBe('bar');
  });

  it('extracts root-level delta.tool_calls', () => {
    const v = { delta: { tool_calls: [{ function: { name: 'root', arguments: '{}' } }] } };
    const events = extractEventsFromChunk(v);
    const calls = getToolCalls(events);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('root');
  });

  it('extracts root-level tool_calls array', () => {
    const v = { tool_calls: [{ id: '1', function: { name: 'alpha', arguments: '{}' } }, { function: { name: 'beta', arguments: '{}' } }] };
    const events = extractEventsFromChunk(v);
    const calls = getToolCalls(events);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.name)).toEqual(['alpha', 'beta']);
  });

  it('extracts message.content and message.tool_calls', () => {
    const v = { message: { content: [{ type: 'text', text: 'Hi' }], tool_calls: [{ function: { name: 'mcall', arguments: '{}' } }] } };
    const events = extractEventsFromChunk(v);
    expect(getContent(events)).toHaveLength(1);
    expect(getToolCalls(events)).toHaveLength(1);
  });

  it('passes through existing channel on delta (e.g., provider-set)', () => {
    const v = { choices: [{ delta: { channel: 'json', content: [{ type: 'text', text: 'A' }] } }] };
    const events = extractEventsFromChunk(v);
    const [content] = getContent(events);
    expect(content?.channel).toBe('json');
  });
});
