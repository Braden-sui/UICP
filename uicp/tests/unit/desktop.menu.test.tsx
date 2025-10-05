import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DesktopMenuBar from '../../src/components/DesktopMenuBar';

describe('DesktopMenuBar', () => {
  it('invokes selected action and closes the menu', () => {
    const openSpy = vi.fn();
    render(
      <DesktopMenuBar
        menus={[
          {
            id: 'logs',
            label: 'Logs',
            actions: [
              { id: 'open', label: 'Open Logs', onSelect: openSpy },
            ],
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /logs/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /open logs/i }));

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
