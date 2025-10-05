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
});

