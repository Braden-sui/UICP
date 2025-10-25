import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, type MouseEvent as ReactMouseEvent } from 'react';
import { motion } from 'motion/react';
import clsx from 'clsx';
import type { DesktopShortcutPosition } from '../state/app';
import { useDynamicStyleRule } from '../hooks/useDynamicStyleRule';
import { escapeForSelector } from '../lib/css/dynamicStyles';
import { iconHoverScale, iconPressScale } from '../lib/ui/animation';
import { useAppStore } from '../state/app';

const ICON_WIDTH = 96; // Tailwind w-24
const ICON_HEIGHT = 104; // Icon + label stack footprint

export type DesktopIconProps = {
  id: string;
  label: string;
  position: DesktopShortcutPosition;
  containerRef: RefObject<HTMLDivElement>;
  onOpen: () => void;
  onPositionChange: (position: DesktopShortcutPosition) => void;
  active?: boolean;
  icon: ReactNode;
  onContextMenu?: (event: ReactMouseEvent<HTMLDivElement>) => void;
};

// DesktopIcon keeps pointer math local so shortcuts feel like a native desktop and remain keyboard accessible.
const DesktopIcon = ({
  id,
  label,
  position,
  containerRef,
  onOpen,
  onPositionChange,
  icon,
  active = false,
  onContextMenu,
}: DesktopIconProps) => {
  const [dragging, setDragging] = useState(false);
  const pointerState = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);

  const clamp = useCallback((next: number, max: number) => {
    if (Number.isNaN(next)) return 0;
    if (max <= 0) return 0;
    return Math.min(Math.max(0, next), max);
  }, []);

  const handleOpen = useCallback(() => {
    onOpen();
  }, [onOpen]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onOpen();
      }
    },
    [onOpen],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const bounds = containerRef.current?.getBoundingClientRect();
      if (!bounds) return;
      pointerState.current = {
        pointerId: event.pointerId,
        offsetX: event.clientX - bounds.left - position.x,
        offsetY: event.clientY - bounds.top - position.y,
        originX: event.clientX,
        originY: event.clientY,
        moved: false,
      };
      const target = event.currentTarget as HTMLElement;
      if (typeof target.setPointerCapture === 'function') {
        target.setPointerCapture(event.pointerId);
      }
    },
    [containerRef, position.x, position.y],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = pointerState.current;
      if (!state || state.pointerId !== event.pointerId) return;
      const bounds = containerRef.current?.getBoundingClientRect();
      if (!bounds) return;

      const deltaX = Math.abs(event.clientX - state.originX);
      const deltaY = Math.abs(event.clientY - state.originY);
      if (!state.moved && (deltaX > 2 || deltaY > 2)) {
        state.moved = true;
        setDragging(true);
      }
      if (!state.moved) return;

      event.preventDefault();
      const maxX = bounds.width - ICON_WIDTH;
      const maxY = bounds.height - ICON_HEIGHT;
      const nextX = clamp(event.clientX - bounds.left - state.offsetX, maxX);
      const nextY = clamp(event.clientY - bounds.top - state.offsetY, maxY);
      onPositionChange({ x: Math.round(nextX), y: Math.round(nextY) });
    },
    [clamp, containerRef, onPositionChange],
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

  const iconSelector = useMemo(() => `[data-shortcut-id="${escapeForSelector(id)}"]`, [id]);

  useDynamicStyleRule(
    iconSelector,
    {
      left: `${position.x}px`,
      top: `${position.y}px`,
    },
    [position.x, position.y],
  );

  // Check if Motion is enabled for spring animations
  const motionEnabled = useAppStore((state) => state.motionEnabled);
  const [isHovered, setIsHovered] = useState(false);
  const [isPressed, setIsPressed] = useState(false);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={active}
      data-shortcut-id={id}
      className={clsx(
        'desktop-icon pointer-events-auto absolute flex w-24 flex-col items-center gap-2 text-slate-700',
        dragging && 'scale-[1.02]',
        active && 'active',
      )}
      onDoubleClick={handleOpen}
      onKeyDown={handleKeyDown}
      onPointerDown={(e) => {
        setIsPressed(true);
        handlePointerDown(e);
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={(e) => {
        setIsPressed(false);
        endPointerTracking(e);
      }}
      onPointerCancel={(e) => {
        setIsPressed(false);
        endPointerTracking(e);
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => {
        setIsHovered(false);
        setIsPressed(false);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (typeof onContextMenu === 'function') onContextMenu(e);
      }}
    >
      <motion.div
        className={clsx(
          'desktop-icon-inner',
          'flex h-16 w-16 items-center justify-center',
          'rounded-2xl border border-slate-200/70',
          'bg-white/80 backdrop-blur-md',
          'shadow-xl',
          !motionEnabled && 'transition-all duration-300 ease-out',
          active && 'ring-2 ring-indigo-400/60 bg-white/95',
          !active && !motionEnabled && 'hover:shadow-2xl',
        )}
        animate={
          motionEnabled
            ? isPressed
              ? iconPressScale
              : isHovered
                ? iconHoverScale
                : { scale: 1, y: 0 }
            : undefined
        }
        transition={
          motionEnabled
            ? {
                type: 'spring',
                stiffness: 400,
                damping: 30,
                mass: 0.8,
              }
            : undefined
        }
      >
        <motion.div
          className="icon-content"
          animate={
            motionEnabled && isHovered && !isPressed
              ? { scale: 1.15 }
              : { scale: 1 }
          }
          transition={
            motionEnabled
              ? {
                  type: 'spring',
                  stiffness: 500,
                  damping: 25,
                }
              : undefined
          }
        >
          {icon}
        </motion.div>
      </motion.div>
      <span
        className={clsx(
          'text-center text-xs font-semibold',
          'transition-all duration-200',
          'drop-shadow-sm',
          active ? 'text-slate-900 scale-105' : 'text-slate-700',
        )}
      >
        {label}
      </span>
    </div>
  );
};

export default DesktopIcon;
