import { describe, it, expect } from 'vitest';
import { extractEventsFromChunk, type StreamEvent } from '../../src/lib/llm/ollama';

describe('extractEventsFromChunk', () => {
  it('parses commentary content and tool_calls from a chunk', () => {
    const chunk = {
      id: 'chatcmpl-123',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'gpt-oss:120b-cloud',
      choices: [
        {
          index: 0,
          delta: {
            channel: 'commentary',
            content: 'Calling tool ',
            tool_calls: [
              {
                index: 0,
                id: 'call_abc',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: '{"city":"Seattle"}',
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };

    const events = extractEventsFromChunk(chunk);
    const types = events.map((e) => e.type);
    expect(types).toContain('content');
    expect(types).toContain('tool_call');

    const content = events.find((e) => e.type === 'content') as Extract<StreamEvent, { type: 'content' }>;
    expect(content.text).toBe('Calling tool ');
    expect(content.channel).toBe('commentary');

    const tool = events.find((e) => e.type === 'tool_call') as Extract<StreamEvent, { type: 'tool_call' }>;
    expect(tool.name).toBe('get_weather');
    expect(tool.arguments).toBe('{"city":"Seattle"}');
    expect(tool.index).toBe(0);
    expect(tool.id).toBe('call_abc');
    expect(tool.isDelta).toBe(true);
  });

  it('handles missing choices gracefully', () => {
    const events = extractEventsFromChunk({});
    expect(events).toEqual([]);
  });

  it('parses Harmony delta messages with analysis/commentary channels', () => {
    const harmonyChunk = {
      delta: {
        messages: [
          {
            channel: 'analysis',
            content: [
              { type: 'output_text', text: 'Thinking about layout options.' },
            ],
          },
          {
            channel: 'commentary',
            content: [
              { type: 'output_text', text: '{ "batch": [ { "op": "window.create" } ] }' },
            ],
          },
        ],
      },
    };

    const events = extractEventsFromChunk(harmonyChunk);
    const analysis = events.find(
      (event): event is Extract<StreamEvent, { type: 'content' }> => event.type === 'content' && event.channel === 'analysis',
    );
    const commentary = events.find(
      (event): event is Extract<StreamEvent, { type: 'content' }> => event.type === 'content' && event.channel === 'commentary',
    );
    expect(analysis).toBeTruthy();
    expect(analysis?.text).toContain('layout options');
    expect(commentary).toBeTruthy();
    expect(commentary?.text).toContain('"batch"');
  });

  it('extracts tool calls from Harmony content blocks', () => {
    const chunk = {
      delta: {
        messages: [
          {
            channel: 'commentary',
            content: [
              {
                type: 'tool_call',
                tool_call: {
                  id: 'tool_1',
                  name: 'create_window',
                  arguments: '{"title":"Demo"}',
                },
              },
            ],
          },
        ],
      },
    };

    const events = extractEventsFromChunk(chunk);
    const toolEvent = events.find((event) => event.type === 'tool_call');
    expect(toolEvent).toBeTruthy();
    expect(toolEvent && toolEvent.name).toBe('create_window');
    expect(toolEvent && toolEvent.arguments).toContain('Demo');
  });
});
