import { useEffect, useRef } from "react";
import { useAppStore } from "../state/app";
import { usePreferencesStore } from "../state/preferences";
import { isTouchDevice } from "../lib/utils";

// Hook listens for proximity, keyboard, and touch gestures to control DockChat visibility.
// Respects user preferences for dock behavior (proximity, auto-hide, always-visible).
export const useDockReveal = (hideDelayMs = 2500) => {
  const chatOpen = useAppStore((state) => state.chatOpen);
  const setChatOpen = useAppStore((state) => state.setChatOpen);
  const streaming = useAppStore((state) => state.streaming);
  const dockBehavior = usePreferencesStore((state) => state.dockBehavior);
  const hideTimer = useRef<number | null>(null);
  const hasFocus = useRef(false);
  const pointerNear = useRef(false);

  // Proximity-based reveal (only active when dockBehavior is 'proximity')
  useEffect(() => {
    if (dockBehavior !== 'proximity') {
      // Always visible mode should open dock immediately
      if (dockBehavior === 'always-visible') {
        setChatOpen(true);
      }
      return;
    }
    const handlePointerMove = (event: PointerEvent) => {
      const threshold = window.innerHeight - 72;
      const near = event.clientY >= threshold;
      pointerNear.current = near;
      if (near) setChatOpen(true);
    };
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", handlePointerMove);
  }, [setChatOpen, dockBehavior]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "/" && !event.metaKey && !event.ctrlKey) {
        const target = event.target as HTMLElement | null;
        const isInput = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
        if (!isInput) {
          event.preventDefault();
          setChatOpen(true);
          // Defer focus so DockChat can mount/update before we reach for the textarea.
          requestAnimationFrame(() => {
            const input = document.querySelector<HTMLTextAreaElement>("[data-dock-chat-input]");
            if (input) {
              input.focus();
              input.setSelectionRange(input.value.length, input.value.length);
            }
          });
        }
      }
      if (event.key === "Escape") {
        if (streaming) return; // Keep dock visible while requests are in flight so STOP stays reachable.
        setChatOpen(false);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [setChatOpen, streaming]);

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

  // Auto-hide logic (respects dockBehavior preferences)
  useEffect(() => {
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    if (!chatOpen) return;
    if (streaming) return;
    // Always-visible mode never auto-hides
    if (dockBehavior === 'always-visible') return;
    // Auto-hide mode hides regardless of pointer/focus (after delay)
    if (dockBehavior === 'auto-hide') {
      hideTimer.current = window.setTimeout(() => {
        if (useAppStore.getState().streaming) {
          return;
        }
        if (usePreferencesStore.getState().dockBehavior === 'always-visible') {
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
    }
    // Proximity mode only hides when not focused and pointer not near
    if (hasFocus.current) return;
    if (pointerNear.current) return;

    hideTimer.current = window.setTimeout(() => {
      if (useAppStore.getState().streaming) {
        return;
      }
      if (usePreferencesStore.getState().dockBehavior === 'always-visible') {
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
  }, [chatOpen, streaming, hideDelayMs, setChatOpen, dockBehavior]);

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
    const currentDockBehavior = usePreferencesStore.getState().dockBehavior;
    // Always-visible mode never hides on blur
    if (currentDockBehavior === 'always-visible') return;
    // Auto-hide mode always sets timer on blur
    if (currentDockBehavior === 'auto-hide') {
      hideTimer.current = window.setTimeout(() => {
        if (useAppStore.getState().streaming) {
          return;
        }
        if (usePreferencesStore.getState().dockBehavior === 'always-visible') {
          return;
        }
        setChatOpen(false);
      }, hideDelayMs);
      return;
    }
    // Proximity mode only hides if pointer not near
    if (!streaming && !pointerNear.current) {
      hideTimer.current = window.setTimeout(() => {
        if (useAppStore.getState().streaming) {
          return;
        }
        if (usePreferencesStore.getState().dockBehavior === 'always-visible') {
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
