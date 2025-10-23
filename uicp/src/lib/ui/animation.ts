/**
 * Centralized Animation Tokens for Motion Integration
 *
 * Maps CSS custom properties to Motion animation configurations.
 * Respects reduced-motion preferences via :root classes and media queries.
 *
 * Contract: All interactive animations use these tokens for consistency.
 */

// Animation duration mappings from CSS variables
// These are read at runtime to respect user preferences set via :root classes
export const getAnimationDurations = () => {
  if (typeof window === 'undefined' || !window.getComputedStyle) {
    // SSR/test fallback
    return {
      fast: 200,
      normal: 400,
      slow: 2500,
      ambient: 20000,
    };
  }

  const root = document.documentElement;
  const styles = window.getComputedStyle(root);

  const parseDuration = (value: string): number => {
    const trimmed = value.trim();
    if (trimmed.endsWith('ms')) {
      return parseFloat(trimmed);
    }
    if (trimmed.endsWith('s')) {
      return parseFloat(trimmed) * 1000;
    }
    return parseFloat(trimmed) || 0;
  };

  return {
    fast: parseDuration(styles.getPropertyValue('--animation-duration-fast')) || 200,
    normal: parseDuration(styles.getPropertyValue('--animation-duration-normal')) || 400,
    slow: parseDuration(styles.getPropertyValue('--animation-duration-slow')) || 2500,
    ambient: parseDuration(styles.getPropertyValue('--animation-duration-ambient')) || 20000,
  };
};

// Check if reduced motion is active
export const isReducedMotion = (): boolean => {
  if (typeof window === 'undefined') return false;

  // Check :root class first (explicit user setting)
  const root = document.documentElement;
  if (root.classList.contains('anim-none')) return true;
  if (root.classList.contains('anim-reduced')) return true;

  // Fall back to media query
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    return mq.matches;
  }

  return false;
};

// Motion easing curves that match current CSS animations
export const easings = {
  // Matches cubic-bezier(0.34, 1.56, 0.64, 1) from window-appear
  windowEnter: [0.34, 1.56, 0.64, 1] as const,

  // Standard ease-out for interactive elements
  easeOut: [0.4, 0.0, 0.2, 1] as const,

  // Ease-in-out for ambient effects
  easeInOut: [0.4, 0.0, 0.6, 1] as const,

  // Spring-like for micro-interactions
  spring: [0.5, 1.5, 0.5, 1] as const,
};

// Window entrance animation configuration
// Matches window-appear keyframe: scale(0.92→1), translateY(20px→0), opacity(0→1)
export const windowVariants = {
  initial: {
    opacity: 0,
    scale: 0.92,
    y: 20,
  },
  animate: {
    opacity: 1,
    scale: 1,
    y: 0,
  },
  exit: {
    opacity: 0,
    scale: 0.92,
    y: 20,
  },
};

// Generate transition config respecting reduced motion
export const getWindowTransition = () => {
  const durations = getAnimationDurations();
  const reduced = isReducedMotion();

  return {
    duration: reduced ? 0 : durations.normal / 1000, // Motion uses seconds
    ease: easings.windowEnter,
  };
};

// Icon spring animation config
export const iconSpring = {
  type: 'spring' as const,
  stiffness: 400,
  damping: 30,
  mass: 0.8,
};

// Panel slide variants (for logs/metrics)
export const panelSlideVariants = {
  initial: {
    opacity: 0,
    y: 10,
  },
  animate: {
    opacity: 1,
    y: 0,
  },
  exit: {
    opacity: 0,
    y: 10,
  },
};

export const getPanelTransition = () => {
  const durations = getAnimationDurations();
  const reduced = isReducedMotion();

  return {
    duration: reduced ? 0 : durations.normal / 1000,
    ease: easings.easeOut,
  };
};

// Hover scale config for icons
export const iconHoverScale = {
  scale: 1.05,
  y: -4,
  transition: {
    duration: 0.2,
    ease: easings.easeOut,
  },
};

// Press scale config for icons
export const iconPressScale = {
  scale: 0.95,
  transition: {
    duration: 0.1,
    ease: easings.easeOut,
  },
};

// Utility: Get Motion-compatible transition that respects reduced motion
export const getTransition = (durationMs: number, easing = easings.easeOut) => {
  const reduced = isReducedMotion();
  return {
    duration: reduced ? 0 : durationMs / 1000,
    ease: easing,
  };
};
