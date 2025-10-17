import { describe, it, expect } from 'vitest';
import { normalizeBatchJson } from '../../src/lib/llm/jsonParsing';

describe('actor JSON compatibility', () => {
  it('accepts method -> op alias in batch JSON', () => {
    const json = JSON.stringify({
      batch: [
        {
          method: 'dom.set',
          params: { windowId: 'win-1', target: '#root', html: '<div id="root">ok</div>' },
        },
      ],
    });
    const parsed = normalizeBatchJson(json);
    expect(parsed[0].op).toBe('dom.set');
    expect((parsed[0].params as { windowId: string }).windowId).toBe('win-1');
  });
});
