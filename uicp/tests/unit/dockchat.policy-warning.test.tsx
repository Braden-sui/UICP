import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DockChat from '../../src/components/DockChat';

vi.mock('../../src/hooks/useContainerStatus', () => ({
  useContainerStatus: () => ({
    loading: false,
    containerStatus: { available: false },
    networkCapabilities: { hasNetwork: false, restricted: true, reason: 'No container' },
    showWarning: true,
    warningMessage: 'Container runtime (Docker/Podman) not found. Network-using prompts will be disabled.',
  }),
}));

describe('<DockChat /> policy warning', () => {
  it('renders warning badge and disables send for network-like prompt', async () => {
    render(<DockChat />);
    const input = await screen.findByTestId('dockchat-input');
    
    // Fire change event with network keyword to trigger isNetworkPrompt
    fireEvent.change(input, { target: { value: 'please fetch data from api' } });

    const warning = await screen.findByRole('alert');
    expect(warning.textContent || '').toMatch(/Container runtime/);

    const send = await screen.findByRole('button', { name: /Send/ });
    expect(send).toBeDisabled();
  });
});


