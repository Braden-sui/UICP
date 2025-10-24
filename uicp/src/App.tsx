import { useMemo } from 'react';
import { MotionConfig } from 'motion/react';
import DockChat from './components/DockChat';
import Desktop from './components/Desktop';
import GrantModal from './components/GrantModal';
import SystemToast from './components/SystemToast';
import DevtoolsComputePanel from './components/DevtoolsComputePanel';
import SystemBanner from './components/SystemBanner';
import AmbientParticles from './components/AmbientParticles';
import PermissionPromptHost from './components/PermissionPromptHost';
import NetGuardToastBridge from './components/NetGuardToastBridge';
import { useApplyTheme } from './state/preferences';
import { useAppStore } from './state/app';
import { isReducedMotion } from './lib/ui/animation';

// App stitches the desktop canvas with the DockChat control surface and supporting overlays.
// Includes ambient particles for premium visual polish.
// Now supports theme switching via preferences store and Motion-powered animations.
const App = () => {
  // Apply theme preferences to DOM
  useApplyTheme();

  // Feature flag: Motion animations enabled
  const motionEnabled = useAppStore((state) => state.motionEnabled);

  // Respect reduced motion: map to Motion's reducedMotion setting
  // "user" = respect system preference (default)
  // "always" = force disable animations
  // Memoize to avoid re-computing on every render and blocking initial paint
  const reducedMotion = useMemo(() => {
    if (!motionEnabled) return 'always';
    try {
      return isReducedMotion() ? 'always' : 'user';
    } catch {
      // Gracefully fall back if DOM not ready
      return 'user';
    }
  }, [motionEnabled]);

  return (
    <MotionConfig reducedMotion={reducedMotion}>
      <div className="relative min-h-screen w-full bg-background text-foreground">
        <AmbientParticles />
        <SystemBanner />
        <Desktop />
        <DockChat />
        <GrantModal />
        <PermissionPromptHost />
        <NetGuardToastBridge />
        <SystemToast />
        {import.meta.env.DEV ? <DevtoolsComputePanel /> : null}
      </div>
    </MotionConfig>
  );
};

export default App;
