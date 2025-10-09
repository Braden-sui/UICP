import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock tauri invoke to supply duplicate persisted commands
vi.mock('@tauri-apps/api/core', () => {
  return {
    invoke: vi.fn(async (cmd: string) => {
      if (cmd === 'get_workspace_commands') {
        // two identical state.set ops with differently ordered args to test stable de-dup
        return [
          { id: 'a', tool: 'state.set', args: { scope: 'workspace', key: 'k', value: 1 } },
          { id: 'b', tool: 'state.set', args: { value: 1, key: 'k', scope: 'workspace' } },
        ];
      }
      return undefined;
    }),
  };
});

// Import after mocks
import { replayWorkspace } from './adapter';

// Provide a minimal window object to satisfy any optional window checks in adapter
beforeEach(() => {
  (globalThis as any).window = (globalThis as any).window || {};
});

describe('replayWorkspace de-duplicates identical ops', () => {
  it('applies only once when tool+args are identical', async () => {
    const { applied, errors } = await replayWorkspace();
    expect(errors).toEqual([]);
    expect(applied).toBe(1);
  });
});
