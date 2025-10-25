import { useEffect, useRef, useState } from 'react';
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

  const modifiedTag = (() => {
    try {
      const current = getEffectivePolicy();
      const base = Presets.open;
      const a = JSON.stringify(current);
      const b = JSON.stringify(base);
      return a !== b ? 'modified' : null;
    } catch {
      return null;
    }
  })();

  // Phase 2a: Comparison matrix data
  const currentPolicy = getEffectivePolicy();
  const row = (label: string, pick: (p: ReturnType<typeof getEffectivePolicy>) => unknown) => {
    const cur = pick(currentPolicy);
    const open = pick(Presets.open as unknown as ReturnType<typeof getEffectivePolicy>);
    const bal = pick(Presets.balanced as unknown as ReturnType<typeof getEffectivePolicy>);
    const lock = pick(Presets.locked as unknown as ReturnType<typeof getEffectivePolicy>);
    return { label, cur, open, bal, lock };
  };
  const comparisonRows = [
    row('network.mode', (p) => p.network.mode),
    row('network.allow_private_lan', (p) => p.network.allow_private_lan),
    row('compute.webrtc', (p) => p.compute.webrtc ?? 'ask'),
    row('compute.workers', (p) => p.compute.workers ?? 'ask'),
    row('compute.service_worker', (p) => p.compute.service_worker ?? 'ask'),
    row('compute.webtransport', (p) => p.compute.webtransport ?? 'ask'),
    row('filesystem.access', (p) => p.filesystem.access),
    row('quotas.domain_defaults.rps', (p) => p.network.quotas?.domain_defaults?.rps ?? '-')
  ];

  // Phase 2b: Recent security events (net guard)
  type NetEvent = {
    ts: number;
    type: 'attempt' | 'block';
    api: 'fetch' | 'xhr' | 'ws' | 'sse' | 'beacon' | 'webrtc' | 'webtransport' | 'worker' | string;
    url: string;
    method?: string;
    reason?: string;
  };
  const toDomain = (url: string) => { try { return new URL(url).hostname; } catch { return ''; } };
  const [events, setEvents] = useState<NetEvent[]>([]);
  const setNetworkInspectorOpen = useAppStore((s) => s.setNetworkInspectorOpen);

  useEffect(() => {
    if (!open) return;
    const onAttempt = (e: Event) => {
      const detail = (e as CustomEvent<{ url: string; api: NetEvent['api']; method?: string }>).detail;
      if (!detail) return;
      const rec: NetEvent = { ts: Date.now(), type: 'attempt', url: detail.url, api: detail.api, method: detail.method };
      setEvents((prev) => [rec, ...prev].slice(0, 200));
    };
    const onBlock = (e: Event) => {
      const detail = (e as CustomEvent<{ url: string; api: NetEvent['api']; reason?: string; method?: string }>).detail;
      if (!detail) return;
      const rec: NetEvent = { ts: Date.now(), type: 'block', url: detail.url, api: detail.api, reason: detail.reason, method: detail.method };
      setEvents((prev) => [rec, ...prev].slice(0, 200));
    };
    window.addEventListener('net-guard-attempt', onAttempt);
    window.addEventListener('net-guard-block', onBlock);
    return () => {
      window.removeEventListener('net-guard-attempt', onAttempt);
      window.removeEventListener('net-guard-block', onBlock);
    };
  }, [open]);

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

        {/* Phase 2a: Comparison matrix */}
        <section className="rounded border bg-white p-2">
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-[12px] font-semibold text-slate-700">Preset comparison</h3>
            <span className="ml-auto text-[11px] text-slate-500">Current vs Open / Balanced / Locked</span>
          </div>
          <div className="overflow-auto">
            <table className="w-full text-left text-[11px]">
              <thead className="sticky top-0 bg-slate-100 text-slate-600">
                <tr>
                  <th className="px-2 py-1">Field</th>
                  <th className="px-2 py-1">Current</th>
                  <th className="px-2 py-1">Open</th>
                  <th className="px-2 py-1">Balanced</th>
                  <th className="px-2 py-1">Locked</th>
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map((r) => (
                  <tr key={String(r.label)}>
                    <td className="px-2 py-1 font-mono">{r.label}</td>
                    <td className="px-2 py-1">{String(r.cur)}</td>
                    <td className="px-2 py-1">{String(r.open)}</td>
                    <td className="px-2 py-1">{String(r.bal)}</td>
                    <td className="px-2 py-1">{String(r.lock)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Phase 2b: Security events summary */}
        <section className="rounded border bg-white p-2">
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-[12px] font-semibold text-slate-700">Recent security events</h3>
            <button type="button" className="rounded border px-2 py-0.5" onClick={() => setNetworkInspectorOpen(true)}>Open Network Inspector</button>
            <button type="button" className="ml-auto rounded border px-2 py-0.5" onClick={() => setEvents([])}>Clear</button>
            <span className="text-[11px] text-slate-500">{events.length} events</span>
          </div>
          <div className="max-h-32 overflow-auto rounded border bg-slate-50">
            <table className="w-full text-left text-[11px]">
              <thead className="sticky top-0 bg-slate-100 text-slate-600">
                <tr>
                  <th className="px-2 py-1">Time</th>
                  <th className="px-2 py-1">Type</th>
                  <th className="px-2 py-1">API</th>
                  <th className="px-2 py-1">Domain</th>
                  <th className="px-2 py-1">Reason</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={`${e.ts}-${i}`} className={e.type === 'block' ? 'bg-rose-50 text-rose-700' : 'bg-white text-slate-700'}>
                    <td className="px-2 py-1 font-mono">{new Date(e.ts).toLocaleTimeString()}</td>
                    <td className="px-2 py-1 uppercase">{e.type}</td>
                    <td className="px-2 py-1">{e.api}</td>
                    <td className="px-2 py-1 font-mono">{toDomain(e.url)}</td>
                    <td className="px-2 py-1">{e.reason ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <div className="flex-1 overflow-auto rounded border bg-white p-2 font-mono text-[11px] text-slate-700">
          <pre className="whitespace-pre-wrap break-words">{policyJson}</pre>
        </div>
      </div>
    </DesktopWindow>
  );
};

export default PolicyViewer;
