import { describe, it, expect } from "vitest";
import { tryParseBatchFromJson } from "../../src/lib/llm/orchestrator";

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
    const parsed = tryParseBatchFromJson(json);
    expect(parsed).not.toBeNull();
    expect(parsed![0].op).toBe('dom.set');
    expect((parsed![0].params as any).windowId).toBe('win-1');
  });
});