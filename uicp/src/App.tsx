import DockChat from './components/DockChat';
import Desktop from './components/Desktop';
import GrantModal from './components/GrantModal';
import SystemToast from './components/SystemToast';
import DevtoolsComputePanel from './components/DevtoolsComputePanel';
import SystemBanner from './components/SystemBanner';
import AmbientParticles from './components/AmbientParticles';

// App stitches the desktop canvas with the DockChat control surface and supporting overlays.
// Includes ambient particles for premium visual polish.
const App = () => (
  <div className="relative min-h-screen w-full bg-[#f7f7f8] text-slate-900">
    <AmbientParticles />
    <SystemBanner />
    <Desktop />
    <DockChat />
    <GrantModal />
    <SystemToast />
    {import.meta.env.DEV ? <DevtoolsComputePanel /> : null}
  </div>
);

export default App;
