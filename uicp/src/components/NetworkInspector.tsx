import { useEffect, useMemo, useState } from 'react';
import DesktopWindow from './DesktopWindow';
import { useAppStore } from '../state/app';

export type NetEvent = {
  ts: number;
  type: 'attempt' | 'block';
  api: 'fetch' | 'xhr' | 'ws' | 'sse' | 'beacon' | 'webrtc' | 'webtransport' | 'worker' | string;
  url: string;
  method?: string;
  reason?: string;
};

const toDomain = (url: string) => {
  try { return new URL(url).hostname; } catch { return ''; }
};

const NetworkInspector = () => {
  const open = useAppStore((s) => s.networkInspectorOpen);
  const setOpen = useAppStore((s) => s.setNetworkInspectorOpen);
  const setPolicyViewerOpen = useAppStore((s) => s.setPolicyViewerOpen);
  const setPolicyViewerSeedRule = useAppStore((s) => s.setPolicyViewerSeedRule);
  const [events, setEvents] = useState<NetEvent[]>([]);

  useEffect(() => {
    if (!open) return;
    const onAttempt = (e: Event) => {
      const detail = (e as CustomEvent<{ url: string; api: NetEvent['api']; method?: string }>).detail;
      const rec: NetEvent = { ts: Date.now(), type: 'attempt', url: detail.url, api: detail.api, method: detail.method };
      setEvents((prev) => [rec, ...prev].slice(0, 300));
    };
    const onBlock = (e: Event) => {
      const detail = (e as CustomEvent<{ url: string; api: NetEvent['api']; reason?: string; method?: string }>).detail;
      const rec: NetEvent = { ts: Date.now(), type: 'block', url: detail.url, api: detail.api, reason: detail.reason, method: detail.method };
      setEvents((prev) => [rec, ...prev].slice(0, 300));
    };
    window.addEventListener('net-guard-attempt', onAttempt);
    window.addEventListener('net-guard-block', onBlock);
    return () => {
      window.removeEventListener('net-guard-attempt', onAttempt);
      window.removeEventListener('net-guard-block', onBlock);
    };
  }, [open]);

  const blocks = useMemo(() => events.filter((e) => e.type === 'block'), [events]);

  return (
    <DesktopWindow
      id="network-inspector"
      title="Network Inspector"
      isOpen={open}
      onClose={() => setOpen(false)}
      initialPosition={{ x: 200, y: 120 }}
      width={640}
      minHeight={360}
    >
      <div className="flex h-full flex-col gap-2 text-xs">
        <div className="flex items-center gap-2">
          <button type="button" className="rounded bg-slate-900 px-2 py-1 text-white" onClick={() => setEvents([])}>Clear</button>
          <button type="button" className="rounded border px-2 py-1" onClick={() => setPolicyViewerOpen(true)}>Open Policy</button>
          <span className="ml-auto text-[11px] text-slate-500">{events.length} events • {blocks.length} blocks</span>
        </div>
        <div className="flex-1 overflow-auto rounded border bg-white">
          <table className="w-full text-left text-[11px]">
            <thead className="sticky top-0 bg-slate-100 text-slate-600">
              <tr>
                <th className="px-2 py-1">Time</th>
                <th className="px-2 py-1">Type</th>
                <th className="px-2 py-1">API</th>
                <th className="px-2 py-1">Domain</th>
                <th className="px-2 py-1">Method</th>
                <th className="px-2 py-1">Reason</th>
                <th className="px-2 py-1">URL</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr
                  key={`${e.ts}-${i}`}
                  className={e.type === 'block' ? 'bg-rose-50 text-rose-700' : 'bg-white text-slate-700'}
                  onDoubleClick={() => { const d = toDomain(e.url); if (d) { setPolicyViewerSeedRule(d); setPolicyViewerOpen(true); } }}
                >
                  <td className="px-2 py-1 font-mono">{new Date(e.ts).toLocaleTimeString()}</td>
                  <td className="px-2 py-1 uppercase">{e.type}</td>
                  <td className="px-2 py-1">{e.api}</td>
                  <td className="px-2 py-1 font-mono">{toDomain(e.url)}</td>
                  <td className="px-2 py-1">{e.method ?? ''}</td>
                  <td className="px-2 py-1">{e.reason ?? ''}</td>
                  <td className="px-2 py-1 font-mono truncate max-w-[360px]">{e.url}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </DesktopWindow>
  );
};

export default NetworkInspector;
