import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import clsx from 'clsx';

export type DesktopWindowProps = {
  id: string;
  title: string;
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  initialPosition?: { x: number; y: number };
  width?: number;
  minWidth?: number;
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
  minWidth: minWidthProp,
  minHeight = 280,
}: DesktopWindowProps) => {
  const titleId = id.concat('-title');
  const windowRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState(initialPosition);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [size, setSize] = useState<{ width: number; height?: number }>({
    width,
    height: undefined,
  });
  const resizeState = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    baseWidth: number;
    baseHeight: number;
    direction: 'east' | 'south' | 'southeast';
  } | null>(null);
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
  const minWidth = useMemo(() => {
    if (Number.isFinite(minWidthProp) && (minWidthProp ?? 0) > 0) {
      return minWidthProp as number;
    }
    return Math.min(Math.max(240, Math.floor(width * 0.6)), width);
  }, [minWidthProp, width]);

  useEffect(() => {
    setPosition({ x: initialX, y: initialY });
  }, [initialX, initialY]);

  useEffect(() => {
    setSize((prev) => ({
      width: width,
      height: prev.height,
    }));
  }, [width]);

  // Ensure the active height respects the latest minHeight whenever the constraint changes.
  useEffect(() => {
    setSize((prev) => {
      if (prev.height === undefined) return prev;
      if (prev.height >= minHeight) return prev;
      return { ...prev, height: minHeight };
    });
  }, [minHeight]);

  const clamp = useCallback((value: number, max: number) => {
    if (Number.isNaN(value)) return 0;
    if (!Number.isFinite(max) || max <= 0) return 0;
    return Math.min(Math.max(0, value), max);
  }, []);

  const clampRange = useCallback((value: number, min: number, max: number) => {
    if (Number.isNaN(value)) return min;
    if (!Number.isFinite(max) || max <= min) return min;
    return Math.min(Math.max(min, value), max);
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isOpen || event.button !== 0) return;
      // Ignore pointer-downs that originate on interactive controls (e.g., Hide button)
      const origin = event.target as HTMLElement | null;
      if (origin && origin.closest('button, a, input, textarea, select, [role="button"], [data-no-drag]')) {
        return;
      }
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
      target.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleResizePointerDown = useCallback(
    (direction: 'east' | 'south' | 'southeast') => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isOpen || event.button !== 0) return;
      const target = event.currentTarget as HTMLElement;
      const rect = windowRef.current?.getBoundingClientRect();
      if (!rect) return;
      const fallbackWidth = size.width;
      const measuredWidth = rect.width > 0 ? rect.width : fallbackWidth;
      const fallbackHeight = size.height ?? minHeight;
      const measuredHeight = rect.height > 0 ? rect.height : fallbackHeight;
      resizeState.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        baseWidth: measuredWidth,
        baseHeight: measuredHeight,
        direction,
      };
      if (typeof target.setPointerCapture === 'function') {
        target.setPointerCapture(event.pointerId);
      }
      setResizing(true);
      event.preventDefault();
      event.stopPropagation();
    },
    [isOpen, minHeight, size.height, size.width],
  );

  const handleResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = resizeState.current;
      if (!state || state.pointerId !== event.pointerId) return;
      const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : Number.POSITIVE_INFINITY;
      const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : Number.POSITIVE_INFINITY;
      const maxWidth = Math.max(minWidth, viewportWidth - position.x - 16);
      const maxHeight = Math.max(minHeight, viewportHeight - position.y - 16);
      const deltaX = event.clientX - state.startX;
      const deltaY = event.clientY - state.startY;
      setSize((prev) => {
        const next: { width: number; height?: number } = {
          width: prev.width,
          height: prev.height,
        };
        if (state.direction === 'east' || state.direction === 'southeast') {
          const rawWidth = state.baseWidth + deltaX;
          next.width = Math.round(clampRange(rawWidth, minWidth, maxWidth));
        }
        if (state.direction === 'south' || state.direction === 'southeast') {
          const rawHeight = state.baseHeight + deltaY;
          next.height = Math.round(clampRange(rawHeight, minHeight, maxHeight));
        }
        return next;
      });
      event.preventDefault();
    },
    [clampRange, minHeight, minWidth, position.x, position.y],
  );

  const endResizeTracking = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const state = resizeState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    resizeState.current = null;
    setResizing(false);
    const target = event.currentTarget as HTMLElement;
    if (typeof target.releasePointerCapture === 'function') {
      target.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
  }, []);

  // Enhanced glassmorphic chrome with multi-layer depth, gradient borders, and premium shadows
  const chromeClasses = useMemo(
    () =>
      clsx(
        'relative flex items-center justify-center rounded-t-2xl px-4 py-2 text-sm font-semibold text-slate-700',
        'bg-gradient-to-b from-white/90 to-white/80 backdrop-blur-xl backdrop-saturate-150',
        'border-t border-x border-white/60',
        'shadow-[inset_0_1px_0_0_rgba(255,255,255,0.8),inset_0_-1px_0_0_rgba(255,255,255,0.4)]',
        dragging ? 'cursor-grabbing select-none' : 'cursor-grab select-none',
      ),
    [dragging],
  );
  // Ensure we only call onClose when provided to avoid runtime errors
  const handleClose = useCallback(() => {
    _onClose?.();
  }, [_onClose]);

  return (
    <div className="pointer-events-none absolute inset-0 z-40" aria-hidden={!isOpen}>
      <div
        ref={windowRef}
        className={clsx('pointer-events-auto absolute', (dragging || resizing) && 'transition-none')}
        style={{
          left: position.x,
          top: position.y,
          width: size.width,
          minHeight,
          minWidth,
          height: size.height,
          display: isOpen ? 'block' : 'none',
        }}
        role="dialog"
        aria-labelledby={titleId}
        data-desktop-window={id}
      >
        <div
          className={clsx(
            'relative flex h-full flex-col overflow-hidden rounded-2xl transition-all duration-200',
            // Premium glassmorphic frame with gradient border simulation via multi-layer shadows
            'border border-white/70 bg-gradient-to-br from-white/95 via-white/90 to-white/85',
            'backdrop-blur-2xl backdrop-saturate-150',
            // Multi-layer depth: outer glow, medium shadow, close contact shadow, and inner highlights
            dragging
              ? 'scale-[1.01] shadow-[0_0_0_1px_rgba(99,102,241,0.2),0_30px_70px_rgba(0,0,0,0.20),0_15px_35px_rgba(0,0,0,0.15),inset_0_1px_0_rgba(255,255,255,0.9)]'
              : 'shadow-[0_0_0_1px_rgba(148,163,184,0.15),0_25px_60px_rgba(0,0,0,0.14),0_10px_25px_rgba(0,0,0,0.10),0_4px_12px_rgba(0,0,0,0.08),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_0_20px_rgba(255,255,255,0.5)]',
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
            <button
              type="button"
              onPointerDown={(e) => {
                // prevent drag capture on the chrome bar
                e.stopPropagation();
              }}
              onClick={handleClose}
              aria-label="Hide window"
              data-no-drag
              className={clsx(
                'absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-[11px] font-semibold text-slate-500',
                'hover:bg-white/70 hover:text-slate-700 active:scale-95 focus:outline-none focus:ring-2 focus:ring-slate-300',
              )}
            >
              Hide
            </button>
          </div>
          <div className="flex-1 overflow-y-auto bg-gradient-to-b from-white/80 via-white/75 to-white/70 px-4 py-3 text-sm text-slate-700 shadow-[inset_0_2px_8px_rgba(0,0,0,0.04),inset_0_1px_0_rgba(0,0,0,0.05)]">
            {children}
          </div>
          <div
            className="absolute inset-y-2 right-0 w-2 cursor-ew-resize rounded-full bg-transparent"
            data-resize-handle="east"
            aria-hidden="true"
            onPointerDown={handleResizePointerDown('east')}
            onPointerMove={handleResizePointerMove}
            onPointerUp={endResizeTracking}
            onPointerCancel={endResizeTracking}
          />
          <div
            className="absolute bottom-0 left-2 right-6 h-2 cursor-ns-resize rounded-full bg-transparent"
            data-resize-handle="south"
            aria-hidden="true"
            onPointerDown={handleResizePointerDown('south')}
            onPointerMove={handleResizePointerMove}
            onPointerUp={endResizeTracking}
            onPointerCancel={endResizeTracking}
          />
          <div
            className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize rounded-br-2xl bg-transparent"
            data-resize-handle="southeast"
            aria-hidden="true"
            onPointerDown={handleResizePointerDown('southeast')}
            onPointerMove={handleResizePointerMove}
            onPointerUp={endResizeTracking}
            onPointerCancel={endResizeTracking}
          />
        </div>
      </div>
    </div>
  );
};

export default DesktopWindow;
