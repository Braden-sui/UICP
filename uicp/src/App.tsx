import DockChat from './components/DockChat';
import Desktop from './components/Desktop';
import GrantModal from './components/GrantModal';
import SystemToast from './components/SystemToast';
import DevtoolsComputePanel from './components/DevtoolsComputePanel';
import SystemBanner from './components/SystemBanner';

// App stitches the desktop canvas with the DockChat control surface and supporting overlays.
const App = () => (
  <div className="relative min-h-screen w-full bg-[#f7f7f8] text-slate-900">
    <SystemBanner />
    <Desktop />
    <DockChat />
    <GrantModal />
    <SystemToast />
    {import.meta.env.DEV ? <DevtoolsComputePanel /> : null}
  </div>
);

export default App;
