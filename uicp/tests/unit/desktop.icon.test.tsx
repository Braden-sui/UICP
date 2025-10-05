import { fireEvent, render } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import DesktopIcon from '../../src/components/DesktopIcon';
import type { DesktopShortcutPosition } from '../../src/state/app';

describe('DesktopIcon', () => {
  const setup = (position: DesktopShortcutPosition = { x: 24, y: 24 }) => {
    const containerRef = createRef<HTMLDivElement>();
    const onOpen = vi.fn();
    const onPositionChange = vi.fn();

    const view = render(
      <div
        ref={containerRef}
        style={{ position: 'relative', width: '800px', height: '600px' }}
        data-testid="desktop-overlay"
      >
        <DesktopIcon
          id="logs"
          label="Logs"
          position={position}
          containerRef={containerRef}
          onOpen={onOpen}
          onPositionChange={onPositionChange}
          icon={<span>ic</span>}
        />
      </div>,
    );

    const container = containerRef.current as HTMLDivElement;
    container.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 600,
      right: 800,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    });

    const icon = view.getByRole('button', { name: /logs/i });
    return { container, icon, onOpen, onPositionChange };
  };

  it('opens on keyboard activation', () => {
    const { icon, onOpen } = setup();
    fireEvent.keyDown(icon, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('reports new coordinates after a drag past the movement threshold', () => {
    const start = { x: 30, y: 30 } satisfies DesktopShortcutPosition;
    const { icon, onPositionChange } = setup(start);

    fireEvent.pointerDown(icon, { clientX: 60, clientY: 60, pointerId: 1, button: 0 });
    fireEvent.pointerMove(icon, { clientX: 150, clientY: 110, pointerId: 1 });
    fireEvent.pointerUp(icon, { pointerId: 1 });

    expect(onPositionChange).toHaveBeenCalled();
    const [next] = onPositionChange.mock.calls[0];
    expect(next.x).toBe(120);
    expect(next.y).toBe(80);
  });
});
