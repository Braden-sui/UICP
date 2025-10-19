import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { Desktop } from '../../src/components/Desktop';
import { useAppStore } from '../../src/state/app';

vi.mock('../../src/lib/bridge/tauri', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/bridge/tauri')>('../../src/lib/bridge/tauri');
  return {
    ...actual,
    inv: vi.fn(async () => ({ ok: true, value: undefined })),
  };
});

describe('Pinned app deletion via right-click', () => {
  beforeEach(() => {
    // Reset store for isolation
    const store = useAppStore.getState();
    store.pinnedWindows = {} as any;
    store.desktopShortcuts = {} as any;
  });

  it('shows confirm and deletes pinned app data when confirmed', async () => {
    const { inv } = await import('../../src/lib/bridge/tauri');
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
    expect((inv as any)).toHaveBeenCalledWith('delete_window_commands', { windowId: 'win-xyz' });

    confirmSpy.mockRestore();
  });
});
