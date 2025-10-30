import { useEffect, useMemo, useState } from 'react';
import { Globe, Shield, AlertTriangle, CheckCircle, Clock, Zap, Database, RefreshCw } from 'lucide-react';
import DesktopWindow from './DesktopWindow';
import { useAppStore } from '../state/app';
import type { BlockEventDetail } from '../lib/security/networkGuard';

export type NetEvent = {
  ts: number;
  type: 'attempt' | 'block' | 'llm_request' | 'llm_response' | 'provider_error';
  api: 'fetch' | 'xhr' | 'ws' | 'sse' | 'beacon' | 'webrtc' | 'webtransport' | 'worker' | 'llm' | string;
  url: string;
  method?: string;
  reason?: string;
  provider?: string;
  model?: string;
  status?: number;
  duration?: number;
  retryCount?: number;
  channelUsed?: 'tool' | 'json' | 'text';
  deltasReceived?: number;
};

type LLMRequestSummary = {
  provider: string;
  model: string;
  totalRequests: number;
  errors: number;
  avgDuration: number;
  totalDeltas: number;
  channelDistribution: Record<string, number>;
};

const toDomain = (url: string) => {
  try { return new URL(url).hostname; } catch { return ''; }
};

const formatDuration = (ms: number) => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

const getStatusIcon = (type: string, status?: number) => {
  switch (type) {
    case 'block':
      return <Shield className="h-3 w-3 text-red-600" />;
    case 'llm_request':
      return <Database className="h-3 w-3 text-blue-600" />;
    case 'llm_response':
      return status && status >= 400 ? 
        <AlertTriangle className="h-3 w-3 text-orange-600" /> : 
        <CheckCircle className="h-3 w-3 text-green-600" />;
    case 'provider_error':
      return <AlertTriangle className="h-3 w-3 text-red-600" />;
    default:
      return <Globe className="h-3 w-3 text-gray-400" />;
  }
};

const EnhancedNetworkInspector = () => {
  const open = useAppStore((s) => s.networkInspectorOpen);
  const setOpen = useAppStore((s) => s.setNetworkInspectorOpen);
  const setPolicyViewerOpen = useAppStore((s) => s.setPolicyViewerOpen);
  const setPolicyViewerSeedRule = useAppStore((s) => s.setPolicyViewerSeedRule);
  const traceEvents = useAppStore((s) => s.traceEvents);
  const [events, setEvents] = useState<NetEvent[]>([]);
  const [showLLMOnly, setShowLLMOnly] = useState(false);

  // Merge network events with LLM trace events
  const allEvents = useMemo(() => {
    const netEvents = events;
    const llmEvents: NetEvent[] = [];
    
    // Extract LLM-related events from trace data
    Object.entries(traceEvents).forEach(([, traceList]) => {
      traceList.forEach(event => {
        if (event.name === 'llm_stream_start' && event.data) {
          llmEvents.push({
            ts: event.timestamp,
            type: 'llm_request',
            api: 'llm',
            url: (event.data.baseUrl || event.data.endpoint || 'unknown') as string,
            provider: event.data.provider as string,
            model: event.data.model as string,
            method: 'POST',
          });
        } else if (event.name === 'llm_stream_complete' && event.data) {
          llmEvents.push({
            ts: event.timestamp,
            type: 'llm_response',
            api: 'llm',
            url: (event.data.baseUrl || event.data.endpoint || 'unknown') as string,
            provider: event.data.provider as string,
            model: event.data.model as string,
            status: event.data.httpStatus as number,
            duration: event.data.durationMs as number,
            channelUsed: event.data.channelUsed as 'tool' | 'json' | 'text',
            deltasReceived: event.data.deltasReceived as number,
          });
        } else if (event.name === 'llm_stream_error' && event.data) {
          llmEvents.push({
            ts: event.timestamp,
            type: 'provider_error',
            api: 'llm',
            url: (event.data.baseUrl || event.data.endpoint || 'unknown') as string,
            provider: event.data.provider as string,
            model: event.data.model as string,
            status: event.data.httpStatus as number,
            reason: event.data.error as string,
            duration: event.data.durationMs as number,
          });
        } else if (event.name === 'provider_decision' && event.data) {
          llmEvents.push({
            ts: event.timestamp,
            type: 'llm_request',
            api: 'llm',
            url: 'router_decision',
            provider: event.data.provider as string,
            model: event.data.model as string,
            method: 'ROUTE',
          });
        }
      });
    });
    
    const combined = [...netEvents, ...llmEvents].sort((a, b) => b.ts - a.ts);
    return showLLMOnly ? combined.filter(e => e.type.includes('llm') || e.type === 'provider_error') : combined;
  }, [events, traceEvents, showLLMOnly]);

  // Generate LLM request summaries
  const llmSummaries = useMemo(() => {
    const llmRequests = allEvents.filter(e => e.type === 'llm_response');
    const summaryMap = new Map<string, LLMRequestSummary>();
    
    llmRequests.forEach(event => {
      const key = `${event.provider}-${event.model}`;
      const existing = summaryMap.get(key) || {
        provider: event.provider || 'unknown',
        model: event.model || 'unknown',
        totalRequests: 0,
        errors: 0,
        avgDuration: 0,
        totalDeltas: 0,
        channelDistribution: {},
      };
      
      existing.totalRequests++;
      if (event.status && event.status >= 400) existing.errors++;
      if (event.duration) existing.avgDuration = (existing.avgDuration + event.duration) / 2;
      if (event.deltasReceived) existing.totalDeltas += event.deltasReceived;
      if (event.channelUsed) {
        existing.channelDistribution[event.channelUsed] = 
          (existing.channelDistribution[event.channelUsed] || 0) + 1;
      }
      
      summaryMap.set(key, existing);
    });
    
    return Array.from(summaryMap.values());
  }, [allEvents]);

  const blocks = useMemo(() => allEvents.filter((e) => e.type === 'block'), [allEvents]);
  const errors = useMemo(() => allEvents.filter((e) => e.type === 'provider_error' || (e.status && e.status >= 400)), [allEvents]);

  useEffect(() => {
    if (!open) return;
    const onAttempt = (e: Event) => {
      const detail = (e as CustomEvent<{ url: string; api: NetEvent['api']; method?: string }>).detail;
      const rec: NetEvent = { ts: Date.now(), type: 'attempt', url: detail.url, api: detail.api, method: detail.method };
      setEvents((prev) => [rec, ...prev].slice(0, 500));
    };
    const onBlock = (e: Event) => {
      const detail = (e as CustomEvent<BlockEventDetail>).detail;
      if (!detail) return;
      const payload = detail.payload;
      const ctx = payload?.context as { url?: string; api?: string; method?: string } | undefined;
      const rec: NetEvent = {
        ts: Date.now(),
        type: 'block',
        url: ctx?.url ?? detail.url,
        api: ((ctx?.api ?? detail.api) as NetEvent['api']) ?? 'fetch',
        reason: payload?.reason ?? detail.reason,
        method: ctx?.method ?? detail.method,
      };
      setEvents((prev) => [rec, ...prev].slice(0, 500));
    };
    window.addEventListener('net-guard-attempt', onAttempt);
    window.addEventListener('net-guard-block', onBlock);
    return () => {
      window.removeEventListener('net-guard-attempt', onAttempt);
      window.removeEventListener('net-guard-block', onBlock);
    };
  }, [open]);

  return (
    <DesktopWindow
      id="enhanced-network-inspector"
      title="Enhanced Network Inspector"
      isOpen={open}
      onClose={() => setOpen(false)}
      initialPosition={{ x: 200, y: 120 }}
      width={800}
      minHeight={480}
    >
      <div className="flex h-full flex-col gap-3 text-xs">
        {/* Controls */}
        <div className="flex items-center gap-2 border-b border-slate-200 pb-2">
          <button 
            type="button" 
            className="rounded bg-slate-900 px-2 py-1 text-white flex items-center gap-1" 
            onClick={() => setEvents([])}
          >
            <RefreshCw className="h-3 w-3" />
            Clear
          </button>
          <button 
            type="button" 
            className="rounded border px-2 py-1" 
            onClick={() => setPolicyViewerOpen(true)}
          >
            Open Policy
          </button>
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={showLLMOnly}
              onChange={(e) => setShowLLMOnly(e.target.checked)}
              className="rounded"
            />
            <span>LLM Only</span>
          </label>
          <span className="ml-auto text-[11px] text-slate-500">
            {allEvents.length} events • {blocks.length} blocks • {errors.length} errors
          </span>
        </div>

        {/* LLM Summaries */}
        {llmSummaries.length > 0 && (
          <div className="border-b border-slate-200 pb-2">
            <h4 className="text-xs font-semibold text-slate-700 mb-2">LLM Request Summary</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {llmSummaries.map((summary, idx) => (
                <div key={idx} className="rounded border border-slate-200 bg-slate-50 p-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium text-slate-900">{summary.provider}</span>
                    <span className="text-slate-600">{summary.model}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-1 text-[10px] text-slate-600">
                    <div>Requests: {summary.totalRequests}</div>
                    <div>Errors: {summary.errors}</div>
                    <div>Avg Duration: {formatDuration(summary.avgDuration)}</div>
                    <div>Total Deltas: {summary.totalDeltas}</div>
                  </div>
                  {Object.keys(summary.channelDistribution).length > 0 && (
                    <div className="mt-1 flex items-center gap-1">
                      <Zap className="h-3 w-3 text-purple-600" />
                      <span className="text-[10px] text-slate-600">
                        {Object.entries(summary.channelDistribution).map(([channel, count]) => 
                          `${channel}: ${count}`
                        ).join(', ')}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Events Table */}
        <div className="flex-1 overflow-auto rounded border bg-white">
          <table className="w-full text-left text-[11px]">
            <thead className="sticky top-0 bg-slate-100 text-slate-600">
              <tr>
                <th className="px-2 py-1">Time</th>
                <th className="px-2 py-1">Type</th>
                <th className="px-2 py-1">API</th>
                <th className="px-2 py-1">Provider</th>
                <th className="px-2 py-1">Model</th>
                <th className="px-2 py-1">Domain</th>
                <th className="px-2 py-1">Status</th>
                <th className="px-2 py-1">Duration</th>
                <th className="px-2 py-1">Reason</th>
                <th className="px-2 py-1">URL</th>
              </tr>
            </thead>
            <tbody>
              {allEvents.map((e, i) => (
                <tr
                  key={`${e.ts}-${i}`}
                  className={
                    e.type === 'block' ? 'bg-rose-50 text-rose-700' : 
                    e.type === 'provider_error' ? 'bg-orange-50 text-orange-700' :
                    e.type.includes('llm') ? 'bg-blue-50 text-blue-700' :
                    'bg-white text-slate-700'
                  }
                  onDoubleClick={() => { 
                    const d = toDomain(e.url); 
                    if (d) { 
                      setPolicyViewerSeedRule(d); 
                      setPolicyViewerOpen(true); 
                    } 
                  }}
                >
                  <td className="px-2 py-1 font-mono">{new Date(e.ts).toLocaleTimeString()}</td>
                  <td className="px-2 py-1">
                    <div className="flex items-center gap-1">
                      {getStatusIcon(e.type, e.status)}
                      <span className="uppercase">{e.type}</span>
                    </div>
                  </td>
                  <td className="px-2 py-1">{e.api}</td>
                  <td className="px-2 py-1">{e.provider || ''}</td>
                  <td className="px-2 py-1">{e.model || ''}</td>
                  <td className="px-2 py-1 font-mono">{toDomain(e.url)}</td>
                  <td className="px-2 py-1">
                    {e.status ? (
                      <span className={e.status >= 400 ? 'text-red-600 font-medium' : 'text-green-600'}>
                        {e.status}
                      </span>
                    ) : e.method ? (
                      <span className="text-slate-600">{e.method}</span>
                    ) : ''}
                  </td>
                  <td className="px-2 py-1">
                    {e.duration ? (
                      <div className="flex items-center gap-1">
                        <Clock className="h-3 w-3 text-slate-400" />
                        {formatDuration(e.duration)}
                      </div>
                    ) : ''}
                  </td>
                  <td className="px-2 py-1">{e.reason ?? ''}</td>
                  <td className="px-2 py-1 font-mono truncate max-w-[240px]">{e.url}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </DesktopWindow>
  );
};

export default EnhancedNetworkInspector;
