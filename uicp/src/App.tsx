import { useEffect, useMemo } from 'react';
import { MotionConfig } from 'motion/react';
import DockChat from './components/DockChat';
import Desktop from './components/Desktop';
import GrantModal from './components/GrantModal';
import KeystoreUnlockModal from './components/KeystoreUnlockModal';
import OnboardingWelcomeModal from './components/OnboardingWelcomeModal';
import SystemToast from './components/SystemToast';
import DevtoolsComputePanel from './components/DevtoolsComputePanel';
import SystemBanner from './components/SystemBanner';
import AmbientParticles from './components/AmbientParticles';
import PermissionPromptHost from './components/PermissionPromptHost';
import NetGuardToastBridge from './components/NetGuardToastBridge';
import PermissionsToastBridge from './components/PermissionsToastBridge';
import ComputeToastBridge from './components/ComputeToastBridge';
import PolicyOverlay from './components/PolicyOverlay';
import { useApplyTheme } from './state/preferences';
import { useAppStore } from './state/app';
import { isReducedMotion } from './lib/ui/animation';
import { onPolicyChange, setRuntimePolicy } from './lib/security/policyLoader';
import { loadPersistedPolicy, persistPolicy } from './lib/security/policyPersistence';
import { useKeystore } from './state/keystore';
import { hasTauriBridge } from './lib/bridge/tauri';

// App stitches the desktop canvas with the DockChat control surface and supporting overlays.
// Includes ambient particles for premium visual polish.
// Now supports theme switching via preferences store and Motion-powered animations.
const App = () => {
  // Apply theme preferences to DOM
  useApplyTheme();

  // Feature flag: Motion animations enabled
  const motionEnabled = useAppStore((state) => state.motionEnabled);
  const refreshStatus = useKeystore((state) => state.refreshStatus);
  const refreshIds = useKeystore((state) => state.refreshIds);

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

  // Policy persistence lifecycle: hydrate from disk and persist on changes
  useMemo(() => {
    (async () => {
      try {
        const p = await loadPersistedPolicy();
        if (p) setRuntimePolicy(p);
      } catch (err) {
        console.warn('[App] failed to load persisted policy', err);
      }
    })();
    try {
      const un = onPolicyChange((p) => { void persistPolicy(p); });
      return () => { try { un(); } catch (err) { console.warn('[App] unsub failed', err); } };
    } catch (err) {
      console.warn('[App] policy change listener setup failed', err);
      return () => {};
    }
  }, []);

  useEffect(() => {
    if (!hasTauriBridge()) return;
    void refreshStatus();
    void refreshIds();
  }, [refreshIds, refreshStatus]);

  return (
    <MotionConfig reducedMotion={reducedMotion}>
      <div className="relative min-h-screen w-full bg-background text-foreground">
        <AmbientParticles />
        <SystemBanner />
        <PolicyOverlay />
        <Desktop />
        <DockChat />
        <OnboardingWelcomeModal />
        <GrantModal />
        <KeystoreUnlockModal />
        <PermissionPromptHost />
        <NetGuardToastBridge />
        <PermissionsToastBridge />
        <SystemToast />
        <ComputeToastBridge />
        {import.meta.env.DEV ? <DevtoolsComputePanel /> : null}
      </div>
    </MotionConfig>
  );
};

export default App;
