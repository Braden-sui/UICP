import DockChat from './components/DockChat';
import Desktop from './components/Desktop';
import GrantModal from './components/GrantModal';
import SystemToast from './components/SystemToast';
import DevtoolsComputePanel from './components/DevtoolsComputePanel';
import SystemBanner from './components/SystemBanner';
import AmbientParticles from './components/AmbientParticles';
import { useApplyTheme } from './state/preferences';

// App stitches the desktop canvas with the DockChat control surface and supporting overlays.
// Includes ambient particles for premium visual polish.
// Now supports theme switching via preferences store.
const App = () => {
  // Apply theme preferences to DOM
  useApplyTheme();

  return (
    <div className="relative min-h-screen w-full bg-background text-foreground">
      <AmbientParticles />
      <SystemBanner />
      <Desktop />
      <DockChat />
      <GrantModal />
      <SystemToast />
      {import.meta.env.DEV ? <DevtoolsComputePanel /> : null}
    </div>
  );
};

export default App;
