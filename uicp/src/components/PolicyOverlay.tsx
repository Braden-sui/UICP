import { useEffect, useState } from 'react';
import { getEffectivePolicy, setRuntimePolicy } from '../lib/security/policyLoader';

const PolicyOverlay = () => {
  const [visible, setVisible] = useState(false);
  const [mode, setMode] = useState<'default_allow' | 'default_deny'>('default_allow');

  useEffect(() => {
    try {
      const pol = getEffectivePolicy();
      setVisible(Boolean(pol.observability?.policy_overlay));
      setMode(pol.network.mode);
    } catch { /* non-fatal */ }
  }, []);

  if (!visible) return null;

  const setPreset = (preset: 'open' | 'balanced' | 'locked') => {
    try {
      const pol = getEffectivePolicy();
      const next = { ...pol };
      if (preset === 'open') {
        next.network.mode = 'default_allow';
        next.compute.webrtc = 'allow';
        next.compute.webtransport = 'allow';
        next.compute.workers = 'allow';
        next.compute.service_worker = 'allow';
      } else if (preset === 'balanced') {
        next.network.mode = 'default_allow';
        next.compute.webrtc = 'ask';
        next.compute.webtransport = 'ask';
        next.compute.workers = 'ask';
        next.compute.service_worker = 'ask';
      } else {
        next.network.mode = 'default_deny';
      }
      setRuntimePolicy(next);
      setMode(next.network.mode);
    } catch { /* non-fatal */ }
  };

  return (
    <div className="pointer-events-auto fixed left-4 top-4 z-50 flex items-center gap-2 rounded-xl border border-slate-200 bg-white/90 px-3 py-2 text-xs text-slate-700 shadow">
      <span className="rounded bg-slate-100 px-2 py-0.5 font-semibold uppercase tracking-wide">{mode}</span>
      <button type="button" className="rounded border px-2 py-0.5 hover:bg-slate-100" onClick={() => setPreset('balanced')}>Balanced</button>
      <button type="button" className="rounded border px-2 py-0.5 hover:bg-slate-100" onClick={() => setPreset('locked')}>Locked</button>
      <button type="button" className="rounded border px-2 py-0.5 hover:bg-slate-100" onClick={() => setPreset('open')}>Open</button>
    </div>
  );
};

export default PolicyOverlay;
