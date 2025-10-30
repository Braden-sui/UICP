import { describe, it, expect, vi } from 'vitest';

// Mock tauri event/core for streaming
const mocks = vi.hoisted(() => ({
  listenMock: vi.fn(async (_name: string, handler: (ev: { payload: any }) => void) => {
    // Simulate two concatenated JSON objects in a single delta (no newline), plus DONE.
    Promise.resolve().then(() => {
      const a = JSON.stringify({ model: 'glm-4.6', message: { role: 'assistant', content: 'BEGIN WIL' }, done: false });
      const b = JSON.stringify({ model: 'glm-4.6', message: { role: 'assistant', content: '\ncreate window title "X"' }, done: false });
      const c = JSON.stringify({ model: 'glm-4.6', message: { role: 'assistant', content: '\nEND WIL' }, done: false });
      handler({ 
        payload: { 
          requestId: 'test-request-id',
          event: { 
            type: 'content',
            channel: 'text',
            text: a + b + c
          }
        } 
      });
      Promise.resolve().then(() => {
        handler({ 
          payload: { 
            requestId: 'test-request-id',
            event: { 
              type: 'done'
            }
          } 
        });
      });
    });
    return () => {};
  }),
  invokeMock: vi.fn(async (_cmd?: string, _args?: any) => undefined),
  tauriInvokeMock: vi.fn(async (_cmd?: string, _args?: any) => undefined),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listenMock }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args?: any) => mocks.invokeMock(cmd, args) }));
vi.mock('../../../src/lib/bridge/tauri', () => ({
  hasTauriBridge: () => true,
  tauriInvoke: mocks.tauriInvokeMock,
}));

import { streamOllamaCompletion } from '../../../src/lib/llm/llm.stream';
import { collectTextFromChannels } from '../../../src/lib/orchestrator/collectTextFromChannels';

describe('concatenated JSON chunk parsing', () => {
  it('extracts message.content from concatenated JSON objects', async () => {
    const iter = streamOllamaCompletion([{ role: 'user', content: 'hi' }], 'glm-4.6');
    const text = await collectTextFromChannels(iter, 2000);
    expect(text).toContain('BEGIN WIL');
    expect(text).toContain('create window title');
    expect(text).toContain('END WIL');
  });
});

