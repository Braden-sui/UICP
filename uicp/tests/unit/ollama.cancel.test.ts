import { describe, it, expect, vi } from 'vitest';

const invokeMock = vi.fn(async (_cmd?: string, _args?: any) => undefined);

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: any) => invokeMock(cmd, args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (_name: string, _handler: (ev: { payload: unknown }) => void) => Promise.resolve(() => {}),
}));

import { streamOllamaCompletion } from '../../src/lib/llm/ollama';

describe('streamOllamaCompletion cancellation', () => {
  it('invokes cancel_chat when iterator is returned early', async () => {
    const iter = streamOllamaCompletion([{ role: 'user', content: 'hi' }]);
    const reader = iter[Symbol.asyncIterator]();
    await reader.return?.();
    expect(invokeMock).toHaveBeenCalled();
    const calledWith = (invokeMock.mock.calls as any[]).map((c: any[]) => c[0]);
    expect(calledWith).toContain('chat_completion');
    expect(calledWith).toContain('cancel_chat');
  });
});
