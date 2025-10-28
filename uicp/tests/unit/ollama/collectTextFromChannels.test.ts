import { describe, it, expect } from 'vitest';
import { collectTextFromChannels } from '../../../src/lib/orchestrator/collectTextFromChannels';
import type { StreamEvent } from '../../../src/lib/llm/llm.stream';

async function* fakeStream(): AsyncIterable<StreamEvent> {
  yield { type: 'content', channel: 'text', text: 'create window ' };
  yield { type: 'content', channel: 'text', text: 'title SmokeTest ' };
  yield { type: 'content', channel: 'text', text: 'width 320 height 200' };
  yield { type: 'done' };
}

describe('collectTextFromChannels', () => {
  it('concatenates content chunks without dropping the tail', async () => {
    const text = await collectTextFromChannels(fakeStream(), 2_000);
    expect(text).toBe('create window title SmokeTest width 320 height 200');
    expect(text.slice(0, 10)).toBe('create win');
    expect(text.slice(-10)).toBe('height 200');
  });
});
