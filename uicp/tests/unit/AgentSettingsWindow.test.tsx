/// <reference types="vitest/globals" />
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AgentSettingsWindow from '../../src/components/AgentSettingsWindow';
import { useAppStore } from '../../src/state/app';

vi.mock('@tauri-apps/api/core', async () => {
  return {
    invoke: vi.fn(async (cmd: string) => {
      if (cmd === 'get_ollama_mode') {
        return [true, false];
      }
      if (cmd === 'get_modules_info') {
        throw new Error('simulated failure');
      }
      if (cmd === 'open_path') {
        throw new Error('open failed');
      }
      return {};
    }),
  };
});

describe('AgentSettingsWindow error handling', () => {
  it('surfaces errors via toasts instead of swallowing', async () => {
    // Open the window to render controls
    useAppStore.getState().setAgentSettingsOpen(true);
    render(<AgentSettingsWindow />);

    // get_modules_info failure should enqueue a toast
    await waitFor(() => {
      const toasts = useAppStore.getState().toasts;
      expect(toasts.some((t) => /Failed to load modules info/.test(t.message))).toBe(true);
    });

    // Reveal advanced controls to expose the Copy Path button
    const advancedToggle = screen.getByRole('button', { name: /Show Advanced/i });
    fireEvent.click(advancedToggle);

    // Clicking Copy Path should also surface an error toast (clipboard not available in test)
    const btn = await screen.findByRole('button', { name: /Copy Path/i });
    fireEvent.click(btn);
    await waitFor(() => {
      const toasts = useAppStore.getState().toasts;
      expect(toasts.some((t) => /Copy failed/.test(t.message))).toBe(true);
    });
  });
});
