import { useEffect } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Theme is now fixed to light mode only
export type ThemeMode = 'light';

// Dock behavior options
export type DockBehavior = 'auto-hide' | 'proximity' | 'always-visible';

// Animation speed options
export type AnimationSpeed = 'normal' | 'reduced' | 'none';

// Font size scaling
export type FontSize = 'small' | 'medium' | 'large' | 'x-large';

export type PreferencesState = {
  // Dock behavior
  dockBehavior: DockBehavior;
  setDockBehavior: (behavior: DockBehavior) => void;

  // Animation speed
  animationSpeed: AnimationSpeed;
  setAnimationSpeed: (speed: AnimationSpeed) => void;

  // Font size scaling
  fontSize: FontSize;
  setFontSize: (size: FontSize) => void;
};

// Font size scale mapping
const FONT_SIZE_SCALE: Record<FontSize, number> = {
  small: 0.875,   // 87.5%
  medium: 1.0,    // 100% (default)
  large: 1.125,   // 112.5%
  'x-large': 1.25 // 125%
};

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      // Default to proximity-based dock reveal
      dockBehavior: 'proximity',
      setDockBehavior: (dockBehavior) => set({ dockBehavior }),

      // Default to normal animations
      animationSpeed: 'normal',
      setAnimationSpeed: (animationSpeed) => set({ animationSpeed }),

      // Default to medium font size
      fontSize: 'medium',
      setFontSize: (fontSize) => set({ fontSize }),
    }),
    {
      name: 'uicp-preferences',
    }
  )
);

/**
 * Hook to apply theme preferences to the DOM.
 * This should be called once at the app root level.
 * Note: Theme is now fixed to light mode.
 */
export const useApplyTheme = () => {
  const animationSpeed = usePreferencesStore((state) => state.animationSpeed);
  const fontSize = usePreferencesStore((state) => state.fontSize);

  useEffect(() => {
    const root = document.documentElement;

    // Always apply light theme
    root.classList.remove('dark');
    root.classList.add('light');
  }, []);

  useEffect(() => {
    const root = document.documentElement;

    // Apply animation speed class
    root.classList.remove('anim-normal', 'anim-reduced', 'anim-none');
    root.classList.add(`anim-${animationSpeed}`);

    // Also set data attribute for CSS selectors
    root.setAttribute('data-animation-speed', animationSpeed);
  }, [animationSpeed]);

  useEffect(() => {
    const root = document.documentElement;

    // Apply font size scaling
    const scale = FONT_SIZE_SCALE[fontSize];
    root.style.fontSize = `${scale * 100}%`;
    root.setAttribute('data-font-size', fontSize);
  }, [fontSize]);
};

/**
 * Utility to get the current resolved theme.
 * Note: Theme is now fixed to light mode.
 */
export const useResolvedTheme = (): 'light' => {
  return 'light';
};
