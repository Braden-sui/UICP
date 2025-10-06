import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DockChat from '../../src/components/DockChat';
import { useAppStore } from '../../src/state/app';
import { registerWorkspaceRoot, resetWorkspace } from '../../src/lib/uicp/adapter';

// DockChat test ensures send flow shows a plan preview and Escape collapses the dock.
describe('DockChat component', () => {
  beforeEach(() => {
    useAppStore.setState({
      chatOpen: true,
      fullControl: false,
      fullControlLocked: false,
      telemetry: [],
      metricsOpen: false,
    });
    resetWorkspace();
    const root = document.createElement('div');
    root.id = 'workspace-root';
    document.body.appendChild(root);
    registerWorkspaceRoot(root);
  });

  it('queues a plan when full control is disabled', async () => {
    render(<DockChat />);
    const textarea = screen.getByPlaceholderText('Describe what you want to build...');
    fireEvent.change(textarea, { target: { value: 'make a notepad' } });
    fireEvent.submit(textarea.closest('form')!);

    await waitFor(() => expect(screen.queryByText(/Plan preview/i)).not.toBeNull());
    expect(useAppStore.getState().chatOpen).toBe(true);
  });

  it('collapses when Escape is pressed', async () => {
    render(<DockChat />);
    expect(useAppStore.getState().chatOpen).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(useAppStore.getState().chatOpen).toBe(false));
  });
});

