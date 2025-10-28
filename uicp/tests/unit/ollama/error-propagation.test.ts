import { describe, it, expect, vi } from 'vitest';

// Hoisted mocks to satisfy Vitest's module mocking order
const mocks = vi.hoisted(() => ({
  listenMock: vi.fn(async (_name: string, handler: (ev: { payload: any }) => void) => {
    // Simulate backend emitting a terminal error payload
    handler({ payload: { done: true, error: { status: 404, code: 'UpstreamFailure', detail: 'Not Found', requestId: 'rid-1' } } });
    return () => {};
  }),
  invokeMock: vi.fn(async (_cmd?: string, _args?: any) => undefined),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listenMock }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args?: any) => mocks.invokeMock(cmd, args) }));

import { streamOllamaCompletion } from '../../../src/lib/llm/llm.stream';
import { collectTextFromChannels } from '../../../src/lib/orchestrator/collectTextFromChannels';

describe('streamOllamaCompletion error propagation', () => {
  it('surfaces upstream errors instead of silently completing', async () => {
    const iter = streamOllamaCompletion([{ role: 'user', content: 'hi' }], 'glm-4.6');
    await expect(collectTextFromChannels(iter, 2_000)).rejects.toThrow(/UpstreamFailure|404|Not Found/);
    expect(mocks.invokeMock).toHaveBeenCalledWith('chat_completion', expect.anything());
  });
});
