import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DockChat from '../../src/components/DockChat';

describe('<DockChat /> policy warning', () => {
  it('keeps send enabled without showing legacy container warning', async () => {
    render(<DockChat />);
    const input = await screen.findByTestId('dockchat-input');

    fireEvent.change(input, { target: { value: 'please fetch data from api' } });

    expect(screen.queryByRole('alert')).toBeNull();

    const send = await screen.findByRole('button', { name: /Send/ });
    expect(send).not.toBeDisabled();
  });
});


