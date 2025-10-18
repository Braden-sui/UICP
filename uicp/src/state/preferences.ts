import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useEffect } from 'react';

// Theme modes
export type ThemeMode = 'light' | 'dark' | 'auto';

// Dock behavior options
export type DockBehavior = 'auto-hide' | 'proximity' | 'always-visible';

// Animation speed options
export type AnimationSpeed = 'normal' | 'reduced' | 'none';

// Font size scaling
export type FontSize = 'small' | 'medium' | 'large' | 'x-large';

export type PreferencesState = {
  // Theme preferences
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;

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
      // Default to light theme
      theme: 'light',
      setTheme: (theme) => set({ theme }),

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
 */
export const useApplyTheme = () => {
  const theme = usePreferencesStore((state) => state.theme);
  const animationSpeed = usePreferencesStore((state) => state.animationSpeed);
  const fontSize = usePreferencesStore((state) => state.fontSize);

  useEffect(() => {
    const root = document.documentElement;

    // Apply theme class
    if (theme === 'auto') {
      // Use system preference
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.classList.toggle('dark', isDark);
      root.classList.toggle('light', !isDark);
    } else {
      root.classList.toggle('dark', theme === 'dark');
      root.classList.toggle('light', theme === 'light');
    }

    // Listen for system theme changes if auto mode
    if (theme === 'auto') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = (e: MediaQueryListEvent) => {
        root.classList.toggle('dark', e.matches);
        root.classList.toggle('light', !e.matches);
      };
      mediaQuery.addEventListener('change', handler);
      return () => mediaQuery.removeEventListener('change', handler);
    }
  }, [theme]);

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
 * Utility to get the current resolved theme (light or dark),
 * taking into account the auto mode.
 */
export const useResolvedTheme = (): 'light' | 'dark' => {
  const theme = usePreferencesStore((state) => state.theme);

  if (theme === 'auto') {
    const [resolvedTheme, setResolvedTheme] = React.useState<'light' | 'dark'>(() => {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    });

    React.useEffect(() => {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = (e: MediaQueryListEvent) => {
        setResolvedTheme(e.matches ? 'dark' : 'light');
      };
      mediaQuery.addEventListener('change', handler);
      return () => mediaQuery.removeEventListener('change', handler);
    }, []);

    return resolvedTheme;
  }

  return theme;
};

// Import React for useResolvedTheme hook
import React from 'react';
