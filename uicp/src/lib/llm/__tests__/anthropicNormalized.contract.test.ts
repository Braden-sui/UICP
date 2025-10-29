import { describe, it, expect } from 'vitest';
import { extractEventsFromChunk, type StreamEvent } from '../llm.stream';

const contents = (evs: StreamEvent[]) => evs.filter((e): e is Extract<StreamEvent, { type: 'content' }> => e.type === 'content');
const calls = (evs: StreamEvent[]) => evs.filter((e): e is Extract<StreamEvent, { type: 'tool_call' }> => e.type === 'tool_call');

describe('Anthropic normalized → StreamEvent v1 (frontend extractor)', () => {
  it('content_block_delta(text_delta) → content event', () => {
    // Shape produced by backend anthropic::normalize_message
    const normalized = {
      choices: [
        {
          delta: {
            content: [{ type: 'text', text: 'Hello' }],
          },
        },
      ],
    };
    const evs = extractEventsFromChunk(normalized);
    expect(contents(evs)[0]?.text).toBe('Hello');
  });

  it('content_block_start(tool_use) → tool_call event', () => {
    // Shape produced by backend anthropic::normalize_message
    const normalized = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'tool_abc',
                name: 'run_cmd',
                function: { name: 'run_cmd', arguments: '{"cmd":"echo hi"}' },
              },
            ],
          },
        },
      ],
    };
    const evs = extractEventsFromChunk(normalized);
    const tc = calls(evs)[0];
    expect(tc?.index).toBe(0);
    expect(tc?.id).toBe('tool_abc');
    expect(tc?.name).toBe('run_cmd');
  });
});
