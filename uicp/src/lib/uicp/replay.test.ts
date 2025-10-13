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
  // WHY: Some adapter code may probe for `window`. In Node/Vitest this can be
  // absent, so we provide a minimal stub to satisfy those optional checks.
  // INVARIANT: We do not rely on any real DOM APIs here; only existence.
  const g = globalThis as typeof globalThis & { window?: object };
  g.window = g.window ?? {};
});

describe('replayWorkspace de-duplicates identical ops', () => {
  it('applies only once when tool+args are identical', async () => {
    const { applied, errors } = await replayWorkspace();
    expect(errors).toEqual([]);
    expect(applied).toBe(1);
  });
});
