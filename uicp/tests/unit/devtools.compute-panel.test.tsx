import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import DevtoolsComputePanel from '../../src/components/DevtoolsComputePanel';

describe('DevtoolsComputePanel', () => {
  afterEach(() => cleanup());

  it('renders with defaultOpen and closes on Escape', () => {
    render(<DevtoolsComputePanel defaultOpen />);
    const dialog = screen.getByRole('dialog', { name: /compute jobs/i });
    expect(dialog).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /compute jobs/i })).toBeNull();
  });
});

