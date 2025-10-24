import { useEffect, useMemo, useState } from 'react';
import DesktopWindow from './DesktopWindow';
import { useAppStore } from '../state/app';
import { getEffectivePolicy, setRuntimePolicy } from '../lib/security/policyLoader';
import { Presets } from '../lib/security/presets';

const stringify = (obj: unknown) => {
  try { return JSON.stringify(obj, null, 2); } catch { return ''; }
};

const PolicyViewer = () => {
  const open = useAppStore((s) => s.policyViewerOpen);
  const setOpen = useAppStore((s) => s.setPolicyViewerOpen);
  const [policyJson, setPolicyJson] = useState<string>('');

  const refresh = () => {
    try {
      const pol = getEffectivePolicy();
      setPolicyJson(stringify(pol));
    } catch {
      setPolicyJson('{}');
    }
  };

  useEffect(() => {
    if (open) refresh();
  }, [open]);

  const applyPreset = (kind: 'open' | 'balanced' | 'locked') => {
    try {
      const preset = kind === 'open' ? Presets.open : kind === 'balanced' ? Presets.balanced : Presets.locked;
      setRuntimePolicy(preset);
      refresh();
    } catch {}
  };

  const pretty = useMemo(() => policyJson, [policyJson]);

  return (
    <DesktopWindow
      id="policy-viewer"
      title="Policy Viewer"
      isOpen={open}
      onClose={() => setOpen(false)}
      initialPosition={{ x: 680, y: 140 }}
      width={520}
      minHeight={480}
    >
      <div className="flex h-full flex-col gap-2 text-xs">
        <div className="flex items-center gap-2">
          <button type="button" className="rounded bg-slate-900 px-2 py-1 text-white" onClick={() => applyPreset('balanced')}>Balanced</button>
          <button type="button" className="rounded bg-slate-700 px-2 py-1 text-white" onClick={() => applyPreset('open')}>Open</button>
          <button type="button" className="rounded bg-slate-700 px-2 py-1 text-white" onClick={() => applyPreset('locked')}>Locked</button>
          <button type="button" className="ml-auto rounded border px-2 py-1" onClick={refresh}>Refresh</button>
        </div>
        <div className="flex-1 overflow-auto rounded border bg-white p-2 font-mono text-[11px] text-slate-700">
          <pre className="whitespace-pre-wrap break-words">{pretty}</pre>
        </div>
      </div>
    </DesktopWindow>
  );
};

export default PolicyViewer;
