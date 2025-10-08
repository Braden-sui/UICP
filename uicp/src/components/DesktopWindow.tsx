import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import { LiquidGlass } from '@liquidglass/react';

export type DesktopWindowProps = {
  id: string;
  title: string;
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  initialPosition?: { x: number; y: number };
  width?: number;
  minHeight?: number;
};

// DesktopWindow wraps ad-hoc panels (like Logs) with movable chrome so the surface behaves like a native OS window.
const DesktopWindow = ({
  id,
  title,
  isOpen,
  onClose: _onClose,
  children,
  initialPosition = { x: 160, y: 140 },
  width = 420,
  minHeight = 280,
}: DesktopWindowProps) => {
  const titleId = id.concat('-title');
  const windowRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState(initialPosition);
  const [dragging, setDragging] = useState(false);
  const pointerState = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);

  const initialX = initialPosition.x;
  const initialY = initialPosition.y;

  useEffect(() => {
    setPosition({ x: initialX, y: initialY });
  }, [initialX, initialY]);

  const clamp = useCallback((value: number, max: number) => {
    if (Number.isNaN(value)) return 0;
    if (!Number.isFinite(max) || max <= 0) return 0;
    return Math.min(Math.max(0, value), max);
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isOpen || event.button !== 0) return;
      pointerState.current = {
        pointerId: event.pointerId,
        offsetX: event.clientX - position.x,
        offsetY: event.clientY - position.y,
        originX: event.clientX,
        originY: event.clientY,
        moved: false,
      };
      event.preventDefault();
      const target = event.currentTarget as HTMLElement;
      if (typeof target.setPointerCapture === 'function') {
        target.setPointerCapture(event.pointerId);
      }
    },
    [isOpen, position.x, position.y],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = pointerState.current;
      if (!state || state.pointerId !== event.pointerId) return;
      const boundsWidth = windowRef.current?.offsetWidth ?? width;
      const boundsHeight = windowRef.current?.offsetHeight ?? minHeight;
      const maxX = window.innerWidth - boundsWidth - 16;
      const maxY = window.innerHeight - boundsHeight - 16;

      const nextX = clamp(event.clientX - state.offsetX, maxX);
      const nextY = clamp(event.clientY - state.offsetY, maxY);

      if (!state.moved) {
        const deltaX = Math.abs(event.clientX - state.originX);
        const deltaY = Math.abs(event.clientY - state.originY);
        if (deltaX > 2 || deltaY > 2) {
          state.moved = true;
        }
      }
      if (!state.moved) {
        event.preventDefault();
        return;
      }
      setDragging(true);
      state.originX = event.clientX;
      state.originY = event.clientY;
      setPosition({ x: Math.round(nextX), y: Math.round(nextY) });
      event.preventDefault();
    },
    [clamp, minHeight, width],
  );

  const endPointerTracking = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const state = pointerState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    pointerState.current = null;
    setDragging(false);
    const target = event.currentTarget as HTMLElement;
    if (typeof target.releasePointerCapture === 'function') {
      try {
        target.releasePointerCapture(event.pointerId);
      } catch {
        // Ignore missing capture edge cases.
      }
    }
  }, []);

  const chromeClasses = useMemo(
    () =>
      clsx(
        'flex items-center justify-center rounded-t-2xl bg-white/80 px-4 py-2 text-sm font-semibold text-slate-700 backdrop-blur',
        dragging ? 'cursor-grabbing select-none' : 'cursor-grab select-none',
      ),
    [dragging],
  );

  return (
    <div className="pointer-events-none absolute inset-0 z-40" aria-hidden={!isOpen}>
      <div
        ref={windowRef}
        className={clsx('pointer-events-auto absolute max-w-[min(90vw,640px)]', dragging && 'transition-none')}
        style={{
          left: position.x,
          top: position.y,
          width,
          minHeight,
          display: isOpen ? 'block' : 'none',
        }}
        role="dialog"
        aria-labelledby={titleId}
        data-desktop-window={id}
      >
        <LiquidGlass
          borderRadius={16}
          blur={0.35}
          contrast={1.18}
          brightness={1.06}
          saturation={1.12}
          shadowIntensity={0.28}
          elasticity={0.65}
          className="h-full"
        >
          <div
            className={clsx(
              'flex h-full flex-col overflow-hidden border border-slate-200/60 bg-white/90 backdrop-blur transition-all duration-200',
              dragging ? 'scale-[1.01] shadow-[0_25px_60px_rgba(0,0,0,0.18)]' : 'shadow-[0_20px_50px_rgba(0,0,0,0.12),0_8px_20px_rgba(0,0,0,0.08)]',
            )}
          >
            <div
              className={chromeClasses}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={endPointerTracking}
              onPointerCancel={endPointerTracking}
            >
              <span id={titleId} className="truncate text-center">
                {title}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto bg-white/70 px-4 py-3 text-sm text-slate-700">{children}</div>
          </div>
        </LiquidGlass>
      </div>
    </div>
  );
};

export default DesktopWindow;
