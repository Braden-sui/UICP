import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DockChat from '../../src/components/DockChat';

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


