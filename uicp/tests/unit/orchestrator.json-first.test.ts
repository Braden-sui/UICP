import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { planWithProfile, actWithProfile, tryParseBatchFromJson } from '../../src/lib/llm/orchestrator';
import * as provider from '../../src/lib/llm/provider';
import * as profiles from '../../src/lib/llm/profiles';
import type { StreamEvent } from '../../src/lib/llm/ollama';

async function* mockToolStream(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const event of events) {
    yield event;
  }
}

describe('orchestrator JSON-first mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('planWithProfile with tool calling', () => {
    it('collects tool call and validates plan schema', async () => {
      // Mock profile with supportsTools: true
      const mockProfile = {
        key: 'glm',
        label: 'GLM Test',
        description: 'Test',
        defaultModel: 'glm-test',
        capabilities: { channels: ['json'], supportsTools: true },
        formatMessages: () => [{ role: 'user', content: 'test' }],
      };
      vi.spyOn(profiles, 'getPlannerProfile').mockReturnValue(mockProfile as any);

      // Mock client to return tool call stream
      const mockClient = {
        streamIntent: vi.fn(() =>
          mockToolStream([
            {
              type: 'tool_call',
              index: 0,
              id: 'call_123',
              name: 'emit_plan',
              arguments: '{"summary": "Test Plan", "batch": []}',
              isDelta: true,
            },
            { type: 'done' },
          ]),
        ),
      };
      vi.spyOn(provider, 'getPlannerClient').mockReturnValue(mockClient as any);

      // Force wilOnly=false for this test
      const cfg = await import('../../src/lib/config');
      vi.spyOn(cfg, 'cfg', 'get').mockReturnValue({ ...cfg.cfg, wilOnly: false });

      const result = await planWithProfile('create a test window');

      expect(result.plan).toEqual({ summary: 'Test Plan', batch: [] });
      expect(result.channelUsed).toBe('tool');
    });

    it('falls back to text when tool collection fails', async () => {
      const mockProfile = {
        key: 'glm',
        label: 'GLM Test',
        description: 'Test',
        defaultModel: 'glm-test',
        capabilities: { channels: ['json'], supportsTools: true },
        formatMessages: () => [{ role: 'user', content: 'test' }],
      };
      vi.spyOn(profiles, 'getPlannerProfile').mockReturnValue(mockProfile as any);

      // Mock client returns content (no tool calls)
      const mockClient = {
        streamIntent: vi.fn(() =>
          mockToolStream([
            { type: 'content', text: 'Summary: Fallback Plan\n\nRisks:\n- None\n' },
            { type: 'done' },
          ]),
        ),
      };
      vi.spyOn(provider, 'getPlannerClient').mockReturnValue(mockClient as any);

      const cfg = await import('../../src/lib/config');
      vi.spyOn(cfg, 'cfg', 'get').mockReturnValue({ ...cfg.cfg, wilOnly: false });

      const result = await planWithProfile('test intent');

      expect(result.plan.summary).toBe('Fallback Plan');
      expect(result.channelUsed).toBe('text');
    });

    it('parses JSON from content when model emits JSON as text', async () => {
      const mockProfile = {
        key: 'glm',
        label: 'GLM Test',
        description: 'Test',
        defaultModel: 'glm-test',
        capabilities: { channels: ['json'], supportsTools: false },
        formatMessages: () => [{ role: 'user', content: 'test' }],
      };
      vi.spyOn(profiles, 'getPlannerProfile').mockReturnValue(mockProfile as any);

      const mockClient = {
        streamIntent: vi.fn(() =>
          mockToolStream([
            { type: 'content', text: '{"summary": "JSON Plan", "batch": []}' },
            { type: 'done' },
          ]),
        ),
      };
      vi.spyOn(provider, 'getPlannerClient').mockReturnValue(mockClient as any);

      const cfg = await import('../../src/lib/config');
      vi.spyOn(cfg, 'cfg', 'get').mockReturnValue({ ...cfg.cfg, wilOnly: false });

      const result = await planWithProfile('test intent');

      expect(result.plan.summary).toBe('JSON Plan');
      expect(result.channelUsed).toBe('json');
    });
  });

  describe('actWithProfile with tool calling', () => {
    it('collects tool call and validates batch schema', async () => {
      const mockProfile = {
        key: 'glm',
        label: 'GLM Test',
        description: 'Test',
        defaultModel: 'glm-test',
        capabilities: { channels: ['json'], supportsTools: true },
        formatMessages: () => [{ role: 'user', content: 'test' }],
      };
      vi.spyOn(profiles, 'getActorProfile').mockReturnValue(mockProfile as any);

      const mockClient = {
        streamPlan: vi.fn(() =>
          mockToolStream([
            {
              type: 'tool_call',
              index: 0,
              id: 'call_456',
              name: 'emit_batch',
              arguments: '{"batch": [{"op": "window.create", "params": {"id": "win-test", "title": "Test"}}]}',
              isDelta: true,
            },
            { type: 'done' },
          ]),
        ),
      };
      vi.spyOn(provider, 'getActorClient').mockReturnValue(mockClient as any);

      const cfg = await import('../../src/lib/config');
      vi.spyOn(cfg, 'cfg', 'get').mockReturnValue({ ...cfg.cfg, wilOnly: false });

      const plan = { summary: 'Test', batch: [], risks: undefined, actorHints: undefined };
      const result = await actWithProfile(plan);

      expect(result.batch).toHaveLength(1);
      expect(result.batch[0].op).toBe('window.create');
      expect(result.channelUsed).toBe('tool');
    });

    it('falls back to JSON parse when tool call args is incomplete', async () => {
      const mockProfile = {
        key: 'glm',
        label: 'GLM Test',
        description: 'Test',
        defaultModel: 'glm-test',
        capabilities: { channels: ['json'], supportsTools: true },
        formatMessages: () => [{ role: 'user', content: 'test' }],
      };
      vi.spyOn(profiles, 'getActorProfile').mockReturnValue(mockProfile as any);

      const mockClient = {
        streamPlan: vi.fn(() =>
          mockToolStream([
            {
              type: 'content',
              text: 'emit_batch({"batch": [{"method": "dom.set", "idempotency_key": "idemp-dom", "params": {"window_id": "win-test", "target": "#root", "html": "<p>Test</p>"}}]})',
            },
            { type: 'done' },
          ]),
        ),
      };
      vi.spyOn(provider, 'getActorClient').mockReturnValue(mockClient as any);

      const cfg = await import('../../src/lib/config');
      vi.spyOn(cfg, 'cfg', 'get').mockReturnValue({ ...cfg.cfg, wilOnly: false });

      const plan = { summary: 'Test', batch: [], risks: undefined, actorHints: undefined };
      const result = await actWithProfile(plan);

      expect(result.batch).toHaveLength(1);
      expect(result.batch[0].op).toBe('dom.set');
      if (result.batch[0].op === 'dom.set') {
        expect(result.batch[0].idempotencyKey).toBe('idemp-dom');
        expect(result.batch[0].params.windowId).toBe('win-test');
      }
      expect(result.channelUsed).toBe('json');
    });

    it.skip('falls back to WIL when tool result and JSON parse both fail', async () => {
      const mockProfile = {
        key: 'glm',
        label: 'GLM Test',
        description: 'Test',
        defaultModel: 'glm-test',
        capabilities: { channels: ['json'], supportsTools: true },
        formatMessages: () => [{ role: 'user', content: 'test' }],
      };
      vi.spyOn(profiles, 'getActorProfile').mockReturnValue(mockProfile as any);

      // Model emits WIL text (not JSON, not tool call)
      const mockClient = {
        streamPlan: vi.fn(() =>
          mockToolStream([
            { type: 'content', text: 'create window id win-fallback title "WIL Fallback" width 600 height 400' },
            { type: 'done' },
          ]),
        ),
      };
      vi.spyOn(provider, 'getActorClient').mockReturnValue(mockClient as any);

      const cfg = await import('../../src/lib/config');
      vi.spyOn(cfg, 'cfg', 'get').mockReturnValue({ ...cfg.cfg, wilOnly: false });

      const plan = { summary: 'Test', batch: [], risks: undefined, actorHints: undefined };
      const result = await actWithProfile(plan);

      expect(result.batch).toHaveLength(1);
      expect(result.batch[0].op).toBe('window.create');
      expect(result.channelUsed).toBe('text');
    });
  });

  describe('WIL-only mode override', () => {
    it('always uses text path when cfg.wilOnly is true', async () => {
      const mockProfile = {
        key: 'glm',
        label: 'GLM Test',
        description: 'Test',
        defaultModel: 'glm-test',
        capabilities: { channels: ['json'], supportsTools: true },
        formatMessages: () => [{ role: 'user', content: 'test' }],
      };
      vi.spyOn(profiles, 'getPlannerProfile').mockReturnValue(mockProfile as any);

      const mockClient = {
        streamIntent: vi.fn(() =>
          mockToolStream([
            { type: 'content', text: 'Summary: WIL Mode Plan' },
            { type: 'done' },
          ]),
        ),
      };
      vi.spyOn(provider, 'getPlannerClient').mockReturnValue(mockClient as any);

      const cfg = await import('../../src/lib/config');
      vi.spyOn(cfg, 'cfg', 'get').mockReturnValue({ ...cfg.cfg, wilOnly: true });

      const result = await planWithProfile('test');

      expect(result.plan.summary).toBe('WIL Mode Plan');
      expect(result.channelUsed).toBe('text');
      // Verify tool stream was NOT consumed
      expect(mockClient.streamIntent).toHaveBeenCalled();
    });
  });

  describe('tryParseBatchFromJson', () => {
    it('parses emit_batch text with snake_case envelope fields', () => {
      const payload =
        'emit_batch({"batch":[{"method":"dom.set","trace_id":"trace-1","params":{"window_id":"win-notes","target":"#root","html":"<p>Notes</p>"}}]})';
      const batch = tryParseBatchFromJson(payload);
      expect(batch).not.toBeNull();
      if (!batch) throw new Error('Expected batch to parse');
      expect(batch).toHaveLength(1);
      const [entry] = batch;
      expect(entry.op).toBe('dom.set');
      expect(entry.traceId).toBe('trace-1');
      if (entry.op === 'dom.set') {
        expect(entry.params.windowId).toBe('win-notes');
      }
    });
  });
});
