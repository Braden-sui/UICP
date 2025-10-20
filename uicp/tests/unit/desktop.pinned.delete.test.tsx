import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { useAppStore } from '../../src/state/app';
import type { Result } from '../../src/lib/bridge/result';

describe('Pinned app deletion via right-click', () => {
  beforeEach(() => {
    // Reset store for isolation
    const store = useAppStore.getState();
    store.pinnedWindows = {} as any;
    store.desktopShortcuts = {} as any;
  });

  it('shows confirm and deletes pinned app data when confirmed', async () => {
    const tauriBridge = await import('../../src/lib/bridge/tauri');
    const invCalls: Array<{ command: string; args: unknown }> = [];
    async function invOverride<T>(command: string, args?: unknown): Promise<Result<T>> {
      invCalls.push({ command, args });
      return { ok: true, value: undefined as T };
    }
    tauriBridge.setInvOverride(invOverride);
    try {
      const { Desktop } = await import('../../src/components/Desktop');
      // Seed a pinned window and its shortcut
      useAppStore.getState().pinWindow('win-xyz', 'My App');
      useAppStore.getState().ensureDesktopShortcut('pinned:win-xyz', { x: 128, y: 64 });

      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

      render(<Desktop />);

      // Find pinned icon by label
      const icon = await screen.findByRole('button', { name: /my app/i });
      // Right click
      fireEvent.contextMenu(icon);

      expect(confirmSpy).toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(invCalls).toContainEqual({
          command: 'delete_window_commands',
          args: { windowId: 'win-xyz' },
        });
      }, { timeout: 2000 });

      confirmSpy.mockRestore();
    } finally {
      tauriBridge.setInvOverride(null);
    }
  });
});
