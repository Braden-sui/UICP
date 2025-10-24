import { useEffect, useMemo, useRef, useState } from 'react';
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
  const seedRule = useAppStore((s) => s.policyViewerSeedRule);
  const setSeedRule = useAppStore((s) => s.setPolicyViewerSeedRule);
  const [policyJson, setPolicyJson] = useState<string>('');
  const [mode, setMode] = useState<'default_allow' | 'default_deny'>('default_allow');
  const [lan, setLan] = useState<'deny' | 'ask' | 'allow'>('ask');
  const [wildcards, setWildcards] = useState<string[]>([]);
  const [newRule, setNewRule] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = () => {
    try {
      const pol = getEffectivePolicy();
      setPolicyJson(stringify(pol));
      setMode(pol.network.mode);
      setLan(pol.network.allow_private_lan);
      const list = (pol.network.wildcard_rules || []).flatMap((r) => Array.isArray(r.allow) ? r.allow : []);
      setWildcards(list);
    } catch {
      setPolicyJson('{}');
    }
  };

  useEffect(() => {
    if (open) refresh();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!seedRule) return;
    setNewRule(seedRule);
    setSeedRule(null);
    inputRef.current?.focus();
  }, [open, seedRule, setSeedRule]);

  const applyPreset = (kind: 'open' | 'balanced' | 'locked') => {
    try {
      const preset = kind === 'open' ? Presets.open : kind === 'balanced' ? Presets.balanced : Presets.locked;
      setRuntimePolicy(preset);
      refresh();
    } catch (err) {
      console.warn('[PolicyViewer] applyPreset failed', err);
    }
  };

  const pretty = useMemo(() => policyJson, [policyJson]);
  const modifiedTag = useMemo(() => {
    try {
      const current = getEffectivePolicy();
      const base = Presets.balanced;
      const a = JSON.stringify(current);
      const b = JSON.stringify(base);
      return a !== b ? 'modified' : null;
    } catch {
      return null;
    }
  }, [policyJson]);

  const saveNetwork = () => {
    try {
      const pol = getEffectivePolicy();
      const next = { ...pol };
      next.network.mode = mode;
      next.network.allow_private_lan = lan;
      // Rebuild rules into a single allow list
      next.network.wildcard_rules = wildcards.length ? [{ allow: Array.from(new Set(wildcards)) }] : [];
      setRuntimePolicy(next);
      refresh();
    } catch (err) {
      console.warn('[PolicyViewer] saveNetwork failed', err);
    }
  };

  const addRule = () => {
    const trimmed = newRule.trim();
    if (!trimmed) return;
    setWildcards((prev) => Array.from(new Set([trimmed, ...prev])));
    setNewRule('');
  };

  const removeRule = (rule: string) => {
    setWildcards((prev) => prev.filter((r) => r !== rule));
  };

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
      <div className="flex h-full flex-col gap-3 text-xs">
        <div className="flex items-center gap-2">
          <button type="button" className="rounded bg-slate-900 px-2 py-1 text-white" onClick={() => applyPreset('balanced')}>Balanced</button>
          <button type="button" className="rounded bg-slate-700 px-2 py-1 text-white" onClick={() => applyPreset('open')}>Open</button>
          <button type="button" className="rounded bg-slate-700 px-2 py-1 text-white" onClick={() => applyPreset('locked')}>Locked</button>
          {modifiedTag && <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">{modifiedTag}</span>}
          <button type="button" className="ml-auto rounded border px-2 py-1" onClick={refresh}>Refresh</button>
        </div>

        <section className="rounded border bg-white p-2">
          <div className="mb-2 flex items-center gap-3">
            <label className="flex items-center gap-2">
              <span className="text-slate-600">Mode</span>
              <select className="rounded border px-2 py-1" value={mode} onChange={(e) => setMode(e.target.value as 'default_allow' | 'default_deny')}>
                <option value="default_allow">default_allow</option>
                <option value="default_deny">default_deny</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className="text-slate-600">Local network</span>
              <select className="rounded border px-2 py-1" value={lan} onChange={(e) => setLan(e.target.value as 'deny' | 'ask' | 'allow')}>
                <option value="deny">deny</option>
                <option value="ask">ask</option>
                <option value="allow">allow</option>
              </select>
            </label>
            <button type="button" className="ml-auto rounded bg-slate-900 px-2 py-1 text-white" onClick={saveNetwork}>Save</button>
          </div>
          <div>
            <div className="mb-2 flex items-center gap-2">
              <input ref={inputRef} value={newRule} onChange={(e) => setNewRule(e.target.value)} placeholder="*.github.com" className="w-64 rounded border px-2 py-1" />
              <button type="button" className="rounded border px-2 py-1" onClick={addRule}>Add rule</button>
            </div>
            <ul className="max-h-28 space-y-1 overflow-auto">
              {wildcards.map((rule) => (
                <li key={rule} className="flex items-center justify-between rounded border bg-slate-50 px-2 py-1">
                  <span className="font-mono">{rule}</span>
                  <button type="button" className="rounded px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-200" onClick={() => removeRule(rule)}>Remove</button>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <div className="flex-1 overflow-auto rounded border bg-white p-2 font-mono text-[11px] text-slate-700">
          <pre className="whitespace-pre-wrap break-words">{pretty}</pre>
        </div>
      </div>
    </DesktopWindow>
  );
};

export default PolicyViewer;
