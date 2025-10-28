import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { actWithProfile } from '../../src/lib/llm/orchestrator';
import * as provider from '../../src/lib/llm/provider';
import * as profiles from '../../src/lib/llm/profiles';
import type { StreamEvent } from '../../src/lib/llm/llm.stream';

async function* mockEvents(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const e of events) yield e;
}

describe('spawn guarantee (Actor JSON-only)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => vi.restoreAllMocks());

  const mockActorProfile = {
    key: 'qwen',
    label: 'Qwen',
    description: 'Test',
    defaultModel: 'qwen3-coder:480b',
    capabilities: { channels: ['json'], supportsTools: true },
    formatMessages: () => [{ role: 'user', content: '{}' }],
  } as any;

  it('injects a window when batch is empty', async () => {
    vi.spyOn(profiles, 'getActorProfile').mockReturnValue(mockActorProfile);
    const mockClient = {
      streamPlan: vi.fn(() =>
        mockEvents([
          { type: 'tool_call', index: 0, id: 'call', name: 'emit_batch', arguments: '{"batch":[]}', isDelta: true },
          { type: 'done' },
        ]),
      ),
    };
    vi.spyOn(provider, 'getActorClient').mockReturnValue(mockClient as any);
    const cfg = await import('../../src/lib/config');
    vi.spyOn(cfg, 'cfg', 'get').mockReturnValue({ ...cfg.cfg, wilOnly: false });

    const result = await actWithProfile({ summary: 't', batch: [], risks: undefined, actorHints: undefined });
    const ops = result.batch.map((e) => e.op);
    expect(ops).toContain('window.create');
    expect(ops).toContain('dom.set');
  });

  it('injects a window when batch has only non-visual ops', async () => {
    vi.spyOn(profiles, 'getActorProfile').mockReturnValue(mockActorProfile);
    const payload = {
      batch: [
        { op: 'state.set', params: { scope: 'workspace', key: 'k', value: 'v' } },
      ],
    };
    const mockClient = {
      streamPlan: vi.fn(() =>
        mockEvents([
          { type: 'tool_call', index: 0, id: 'call', name: 'emit_batch', arguments: JSON.stringify(payload), isDelta: true },
          { type: 'done' },
        ]),
      ),
    };
    vi.spyOn(provider, 'getActorClient').mockReturnValue(mockClient as any);
    const cfg = await import('../../src/lib/config');
    vi.spyOn(cfg, 'cfg', 'get').mockReturnValue({ ...cfg.cfg, wilOnly: false });

    const result = await actWithProfile({ summary: 't', batch: [], risks: undefined, actorHints: undefined });
    const ops = result.batch.map((e) => e.op);
    expect(ops[0]).toBe('window.create');
    expect(ops).toContain('dom.set');
    expect(ops).toContain('state.set');
  });
});

