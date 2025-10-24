import { useEffect, useState } from 'react';
import { useAppStore } from '../state/app';
import { getEffectivePolicy, setRuntimePolicy } from '../lib/security/policyLoader';

const FirstRunPermissionsSheet = () => {
  const reviewed = useAppStore((s) => s.firstRunPermissionsReviewed);
  const setReviewed = useAppStore((s) => s.setFirstRunPermissionsReviewed);
  const [open, setOpen] = useState(false);

  const [internet, setInternet] = useState(true);
  const [localNetwork, setLocalNetwork] = useState<'deny' | 'ask' | 'allow'>('ask');
  const [realtime, setRealtime] = useState<'deny' | 'ask' | 'allow'>('ask');
  const [filesystem, setFilesystem] = useState<'deny' | 'prompt' | 'allow'>('prompt');

  useEffect(() => {
    if (!reviewed) {
      try {
        const pol = getEffectivePolicy();
        setInternet(true);
        setLocalNetwork(pol.network.allow_private_lan);
        setRealtime(pol.compute.webrtc ?? 'ask');
        setFilesystem(pol.filesystem.access);
      } catch {}
      setOpen(true);
    }
  }, [reviewed]);

  if (!open) return null;

  const accept = () => {
    try {
      const pol = getEffectivePolicy();
      const next = { ...pol };
      next.network.mode = internet ? 'default_allow' : 'default_deny';
      next.network.allow_private_lan = localNetwork;
      next.compute.webrtc = realtime;
      next.compute.webtransport = realtime;
      next.filesystem.access = filesystem;
      setRuntimePolicy(next);
    } catch {}
    setReviewed(true);
    setOpen(false);
  };

  const cancel = () => {
    setReviewed(true);
    setOpen(false);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm">
      <div className="w-[min(560px,92vw)] rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
        <h2 className="text-lg font-semibold text-slate-900">Set project permissions</h2>
        <p className="mt-1 text-sm text-slate-600">Choose defaults for this project. You can change these later in Policy Viewer.</p>
        <div className="mt-4 grid grid-cols-1 gap-3 text-sm">
          <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
            <span className="text-slate-700">Internet access</span>
            <select className="rounded border px-2 py-1 text-sm" value={internet ? 'on' : 'off'} onChange={(e) => setInternet(e.target.value === 'on')}>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
            <span className="text-slate-700">Local network</span>
            <select className="rounded border px-2 py-1 text-sm" value={localNetwork} onChange={(e) => setLocalNetwork(e.target.value as any)}>
              <option value="deny">Deny</option>
              <option value="ask">Ask</option>
              <option value="allow">Allow</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
            <span className="text-slate-700">Real-time connectivity</span>
            <select className="rounded border px-2 py-1 text-sm" value={realtime} onChange={(e) => setRealtime(e.target.value as any)}>
              <option value="deny">Deny</option>
              <option value="ask">Ask</option>
              <option value="allow">Allow</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
            <span className="text-slate-700">Filesystem</span>
            <select className="rounded border px-2 py-1 text-sm" value={filesystem} onChange={(e) => setFilesystem(e.target.value as any)}>
              <option value="deny">Deny</option>
              <option value="prompt">Prompt</option>
              <option value="allow">Allow</option>
            </select>
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="rounded border px-3 py-1 text-sm" onClick={cancel}>Skip</button>
          <button type="button" className="rounded bg-slate-900 px-3 py-1 text-sm font-semibold text-white" onClick={accept}>Accept</button>
        </div>
      </div>
    </div>
  );
};

export default FirstRunPermissionsSheet;
