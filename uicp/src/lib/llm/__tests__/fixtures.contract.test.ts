import { describe, it, expect } from 'vitest';
import { extractEventsFromChunk, type StreamEvent } from '../llm.stream';
import {
  openaiDeltaContent,
  openrouterDeltaToolCalls,
  anthropicNormalizedTextDelta,
  anthropicNormalizedToolUseStart,
  ollamaTextLine,
} from '../__fixtures__/provider.fixtures';

const contents = (evs: StreamEvent[]) => evs.filter((e): e is Extract<StreamEvent, { type: 'content' }> => e.type === 'content');
const calls = (evs: StreamEvent[]) => evs.filter((e): e is Extract<StreamEvent, { type: 'tool_call' }> => e.type === 'tool_call');

describe('Provider fixtures → StreamEvent v1 (frontend extractor)', () => {
  it('OpenAI delta content (with channel passthrough json)', () => {
    const chunk = JSON.parse(JSON.stringify(openaiDeltaContent));
    if (Array.isArray(chunk.choices) && chunk.choices[0] && chunk.choices[0].delta) {
      chunk.choices[0].delta.channel = 'json';
    }
    const evs = extractEventsFromChunk(chunk);
    expect(contents(evs)[0]?.text).toBe('Hello');
    expect(contents(evs)[0]?.channel).toBe('json');
  });

  it('OpenAI delta content (with channel passthrough text)', () => {
    const chunk = { choices: [{ delta: { channel: 'text', content: 'note' } }] };
    const evs = extractEventsFromChunk(chunk);
    expect(contents(evs)[0]?.text).toBe('note');
    expect(contents(evs)[0]?.channel).toBe('text');
  });

  it('OpenRouter delta tool_calls', () => {
    const evs = extractEventsFromChunk(openrouterDeltaToolCalls);
    const c = calls(evs)[0];
    expect(c?.index).toBe(0);
    expect(c?.id).toBe('call_0');
    expect(c?.name).toBe('emit_batch');
    expect(c?.isDelta).toBe(true);
  });

  it('Anthropic normalized text → content', () => {
    const evs = extractEventsFromChunk(anthropicNormalizedTextDelta);
    expect(contents(evs)[0]?.text).toBe('Hello');
  });

  it('Anthropic normalized tool_use → tool_call', () => {
    const evs = extractEventsFromChunk(anthropicNormalizedToolUseStart);
    const tc = calls(evs)[0];
    expect(tc?.id).toBe('tool_abc');
    expect(tc?.name).toBe('run_cmd');
    expect(typeof tc?.arguments === 'string' || typeof tc?.arguments === 'object').toBe(true);
  });

  it('Ollama text line → content (no channel tag)', () => {
    const evs = extractEventsFromChunk(ollamaTextLine);
    const c = contents(evs)[0];
    expect(c?.text).toContain('status:');
    expect(c?.channel).toBeUndefined();
  });
});
