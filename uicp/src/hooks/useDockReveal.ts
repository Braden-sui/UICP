import { useEffect, useRef } from "react";
import { useAppStore } from "../state/app";
import { isTouchDevice } from "../lib/utils";

// Hook listens for proximity, keyboard, and touch gestures to control DockChat visibility.
export const useDockReveal = (hideDelayMs = 2500) => {
  const chatOpen = useAppStore((state) => state.chatOpen);
  const setChatOpen = useAppStore((state) => state.setChatOpen);
  const streaming = useAppStore((state) => state.streaming);
  const hideTimer = useRef<number | null>(null);
  const hasFocus = useRef(false);
  const pointerNear = useRef(false);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const threshold = window.innerHeight - 72;
      const near = event.clientY >= threshold;
      pointerNear.current = near;
      if (near) setChatOpen(true);
    };
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", handlePointerMove);
  }, [setChatOpen]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "/" && !event.metaKey && !event.ctrlKey) {
        const target = event.target as HTMLElement | null;
        const isInput = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
        if (!isInput) {
          event.preventDefault();
          setChatOpen(true);
        }
      }
      if (event.key === "Escape") {
        setChatOpen(false);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [setChatOpen]);

  useEffect(() => {
    if (!isTouchDevice()) return;
    let touchStartY = 0;
    let touchStartTime = 0;

    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      touchStartY = touch.clientY;
      touchStartTime = Date.now();
    };

    const handleTouchEnd = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      const deltaY = touchStartY - touch.clientY;
      const deltaTime = Date.now() - touchStartTime;
      if (touchStartY >= window.innerHeight - 96 && deltaY > 32 && deltaTime < 600) {
        setChatOpen(true);
      }
    };

    window.addEventListener("touchstart", handleTouchStart, { passive: true });
    window.addEventListener("touchend", handleTouchEnd);
    return () => {
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchend", handleTouchEnd);
    };
  }, [setChatOpen]);

  useEffect(() => {
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    if (!chatOpen) return;
    if (streaming) return;
    if (hasFocus.current) return;
    if (pointerNear.current) return;

    hideTimer.current = window.setTimeout(() => {
      if (useAppStore.getState().streaming) {
        return;
      }
      setChatOpen(false);
    }, hideDelayMs);

    return () => {
      if (hideTimer.current) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };
  }, [chatOpen, streaming, hideDelayMs, setChatOpen]);

  const onFocus = () => {
    hasFocus.current = true;
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  const onBlur = () => {
    hasFocus.current = false;
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current);
    }
    if (!streaming && !pointerNear.current) {
      hideTimer.current = window.setTimeout(() => {
        if (useAppStore.getState().streaming) {
          return;
        }
        setChatOpen(false);
      }, hideDelayMs);
    }
  };

  return {
    chatOpen,
    onFocus,
    onBlur,
    setChatOpen,
  };
};
