import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Clock, Zap, Database, AlertTriangle, CheckCircle, XCircle, Activity } from 'lucide-react';
import { useAppStore } from '../state/app';
import type { TraceEvent } from '../lib/telemetry/types';

type LLMTraceViewerProps = {
  traceId?: string;
};

type TraceSummary = {
  totalEvents: number;
  duration: number;
  success: boolean;
  provider?: string;
  model?: string;
  channelUsed?: 'tool' | 'json' | 'text';
  deltasCount: number;
  errorCount: number;
};

type EventGroup = {
  span: string;
  events: TraceEvent[];
  duration: number;
  status: 'ok' | 'error' | 'timeout';
};

const getStatusIcon = (status: string) => {
  switch (status) {
    case 'ok':
    case 'complete':
      return <CheckCircle className="h-3 w-3 text-green-600" />;
    case 'error':
      return <XCircle className="h-3 w-3 text-red-600" />;
    case 'timeout':
      return <Clock className="h-3 w-3 text-yellow-600" />;
    default:
      return <Activity className="h-3 w-3 text-gray-400" />;
  }
};

const getChannelIcon = (channel?: string) => {
  switch (channel) {
    case 'tool':
      return <Zap className="h-3 w-3 text-purple-600" />;
    case 'json':
      return <Database className="h-3 w-3 text-blue-600" />;
    case 'text':
      return <AlertTriangle className="h-3 w-3 text-orange-600" />;
    default:
      return null;
  }
};

const formatDuration = (ms: number) => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

const LLMTraceViewer = ({ traceId }: LLMTraceViewerProps) => {
  const traceEvents = useAppStore((state) => state.traceEvents);
  const traceProviders = useAppStore((state) => state.traceProviders);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(['planner', 'actor']));
  
  const traces = useMemo(() => {
    if (!traceId) return { summary: null, groups: [], events: [] };
    const events = traceEvents[traceId] || [];
    const provider = traceProviders[traceId];
    
    // Calculate trace summary
    const summary: TraceSummary = {
      totalEvents: events.length,
      duration: 0,
      success: true,
      provider,
      deltasCount: 0,
      errorCount: 0,
    };
    
    // Find start/end times and extract metrics
    const startTimes = events.filter(e => e.kind === 'span_start').map(e => e.timestamp);
    const endTimes = events.filter(e => e.kind === 'span_finish').map(e => e.timestamp);
    
    if (startTimes.length > 0 && endTimes.length > 0) {
      summary.duration = Math.max(...endTimes) - Math.min(...startTimes);
    }
    
    // Count errors and extract metrics
    events.forEach(event => {
      if (event.status === 'error') summary.errorCount++;
      if (event.name === 'llm_stream_complete' && event.data?.deltasReceived) {
        summary.deltasCount = event.data.deltasReceived as number;
      }
      if (event.data?.channelUsed) {
        summary.channelUsed = event.data.channelUsed as 'tool' | 'json' | 'text';
      }
      if (event.data?.model) {
        summary.model = event.data.model as string;
      }
    });
    
    summary.success = summary.errorCount === 0;
    
    // Group events by span
    const spanGroups = new Map<string, TraceEvent[]>();
    events.forEach(event => {
      const span = event.span || 'general';
      const group = spanGroups.get(span) || [];
      group.push(event);
      spanGroups.set(span, group);
    });
    
    // Create event groups with durations
    const groups: EventGroup[] = Array.from(spanGroups.entries()).map(([span, events]) => {
      const spanEvents = events.filter(e => e.name.includes(span) || e.span === span);
      const startEvent = spanEvents.find(e => e.kind === 'span_start');
      const endEvent = spanEvents.find(e => e.kind === 'span_finish');
      const duration = startEvent && endEvent ? endEvent.timestamp - startEvent.timestamp : 0;
      const status = events.some(e => e.status === 'error') ? 'error' : 
                    events.some(e => e.status === 'timeout') ? 'timeout' : 'ok';
      
      return { span, events, duration, status };
    });
    
    return { summary, groups, events };
  }, [traceId, traceEvents, traceProviders]);
  
  const toggleGroup = (span: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(span)) {
        next.delete(span);
      } else {
        next.add(span);
      }
      return next;
    });
  };
  
  if (!traceId || !traces.summary) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Activity className="h-4 w-4" />
          No trace data available
        </div>
      </div>
    );
  }
  
  const { summary, groups } = traces;
  
  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      {/* Trace Summary */}
      <div className="border-b border-slate-200 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-slate-900">LLM Trace {traceId}</h3>
          <div className="flex items-center gap-2">
            {getStatusIcon(summary.success ? 'ok' : 'error')}
            <span className={`text-xs font-medium ${
              summary.success ? 'text-green-700' : 'text-red-700'
            }`}>
              {summary.success ? 'Success' : 'Failed'}
            </span>
          </div>
        </div>
        
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <div className="flex items-center gap-1">
            <Clock className="h-3 w-3 text-slate-400" />
            <span className="text-slate-600">Duration:</span>
            <span className="font-medium text-slate-900">{formatDuration(summary.duration)}</span>
          </div>
          
          <div className="flex items-center gap-1">
            <Activity className="h-3 w-3 text-slate-400" />
            <span className="text-slate-600">Events:</span>
            <span className="font-medium text-slate-900">{summary.totalEvents}</span>
          </div>
          
          <div className="flex items-center gap-1">
            {getChannelIcon(summary.channelUsed)}
            <span className="text-slate-600">Channel:</span>
            <span className="font-medium text-slate-900">{summary.channelUsed || 'unknown'}</span>
          </div>
          
          <div className="flex items-center gap-1">
            <Zap className="h-3 w-3 text-slate-400" />
            <span className="text-slate-600">Deltas:</span>
            <span className="font-medium text-slate-900">{summary.deltasCount}</span>
          </div>
        </div>
        
        {(summary.provider || summary.model) && (
          <div className="mt-2 flex items-center gap-3 text-xs">
            {summary.provider && (
              <div className="flex items-center gap-1">
                <Database className="h-3 w-3 text-slate-400" />
                <span className="text-slate-600">Provider:</span>
                <span className="font-medium text-slate-900">{summary.provider}</span>
              </div>
            )}
            {summary.model && (
              <div className="flex items-center gap-1">
                <span className="text-slate-600">Model:</span>
                <span className="font-medium text-slate-900">{summary.model}</span>
              </div>
            )}
          </div>
        )}
      </div>
      
      {/* Event Groups */}
      <div className="divide-y divide-slate-100">
        {groups.map((group: EventGroup) => (
          <div key={group.span} className="p-3">
            <button
              onClick={() => toggleGroup(group.span)}
              className="flex items-center justify-between w-full text-left hover:bg-slate-50 rounded p-1 -m-1 transition-colors"
            >
              <div className="flex items-center gap-2">
                {expandedGroups.has(group.span) ? 
                  <ChevronDown className="h-3 w-3 text-slate-400" /> : 
                  <ChevronRight className="h-3 w-3 text-slate-400" />
                }
                {getStatusIcon(group.status)}
                <span className="text-sm font-medium text-slate-900 capitalize">{group.span}</span>
                <span className="text-xs text-slate-500">({group.events.length} events)</span>
              </div>
              <div className="flex items-center gap-2">
                {group.duration > 0 && (
                  <span className="text-xs text-slate-500">{formatDuration(group.duration)}</span>
                )}
              </div>
            </button>
            
            {expandedGroups.has(group.span) && (
              <div className="mt-2 ml-6 space-y-1">
                {group.events.map((event: TraceEvent) => (
                  <div key={event.id} className="flex items-start gap-2 text-xs p-2 rounded bg-slate-50">
                    <div className="flex-shrink-0 mt-0.5">
                      {getStatusIcon(event.status || 'ok')}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-slate-900">{event.name}</span>
                        <span className="text-slate-500">
                          {new Date(event.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                      {event.data && Object.keys(event.data).length > 0 && (
                        <div className="mt-1 text-slate-600">
                          {Object.entries(event.data).map(([key, value]) => (
                            <div key={key} className="flex items-center gap-1">
                              <span className="text-slate-500">{key}:</span>
                              <span className="truncate">{String(value)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default LLMTraceViewer;
