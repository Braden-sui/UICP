import { Fragment, useMemo } from 'react';
import DesktopWindow from './DesktopWindow';
import { useAppSelector } from '../state/app';
import type { TraceEvent } from '../lib/telemetry/types';

const MAX_TRACES = 5;

type TraceSectionProps = {
  traceId: string;
  summary?: string;
  events: TraceEvent[];
};

const TraceSection = ({ traceId, summary, events }: TraceSectionProps) => {
  const grouped = useMemo(() => {
    const spans = new Map<string, TraceEvent[]>();
    for (const event of events) {
      const span = event.span ?? 'general';
      const bucket = spans.get(span) ?? [];
      bucket.push(event);
      spans.set(span, bucket);
    }
    return Array.from(spans.entries());
  }, [events]);

  const provider = useAppSelector((state) => state.traceProviders[traceId] ?? null);

  return (
    <section className="rounded-md border border-slate-200 bg-white/80 p-2 shadow-sm">
      <header className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase text-slate-500">
        <span>Trace {traceId}</span>
        <div className="flex items-center gap-2">
          {provider && (
            <span className={`rounded px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
              provider === 'wasm'
                ? 'bg-emerald-50 text-emerald-700'
                : provider === 'codegen'
                  ? 'bg-amber-50 text-amber-700'
                  : provider === 'llm'
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'bg-slate-100 text-slate-600'
            }`}
            >{provider}</span>
          )}
          {summary && <span className="line-clamp-1 text-[10px] font-normal normal-case text-slate-400"> {summary}</span>}
        </div>
      </header>
      {grouped.length === 0 ? (
        <p className="text-[11px] text-slate-400">No events recorded.</p>
      ) : (
        <div className="space-y-2">
          {grouped.map(([span, spanEvents]) => (
            <div key={`${traceId}-${span}`} className="space-y-1">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{span}</div>
              <ul className="space-y-1">
                {spanEvents.map((event) => (
                  <li
                    key={event.id}
                    className="flex items-start justify-between gap-2 rounded bg-slate-50 px-2 py-1 text-[11px] text-slate-600"
                  >
                    <div className="flex flex-col">
                      <span className="font-mono text-[10px] uppercase text-slate-500">{event.name}</span>
                      {event.data && (
                        <dl className="mt-0.5 grid grid-cols-[auto,1fr] gap-x-1 text-[10px] text-slate-400">
                          {Object.entries(event.data).map(([key, value]) => (
                            <Fragment key={key}>
                              <dt className="capitalize">{key}</dt>
                              <dd className="overflow-hidden text-ellipsis whitespace-nowrap">
                                {typeof value === 'string' || typeof value === 'number' ? value : JSON.stringify(value)}
                              </dd>
                            </Fragment>
                          ))}
                        </dl>
                      )}
                    </div>
                    <div className="flex flex-col items-end text-right text-[10px] text-slate-400">
                      {event.durationMs != null && <span>{event.durationMs} ms</span>}
                      {event.status && <span className="uppercase">{event.status}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

const AgentTraceWindow = () => {
  const devMode = useAppSelector((state) => state.devMode);
  const agentTraceOpen = useAppSelector((state) => state.agentTraceOpen);
  const setAgentTraceOpen = useAppSelector((state) => state.setAgentTraceOpen);
  const traceOrder = useAppSelector((state) => state.traceOrder);
  const traceEvents = useAppSelector((state) => state.traceEvents);
  const telemetry = useAppSelector((state) => state.telemetry);

  const showWindow = devMode || import.meta.env.DEV;
  if (!showWindow) return null;

  const traces = traceOrder.slice(0, MAX_TRACES).map((traceId) => {
    const events = traceEvents[traceId] ?? [];
    const summary = telemetry.find((entry) => entry.traceId === traceId)?.summary;
    return { traceId, events, summary };
  });

  return (
    <DesktopWindow
      id="agent-trace"
      title="Agent Trace"
      isOpen={agentTraceOpen}
      onClose={() => setAgentTraceOpen(false)}
      width={360}
      minHeight={320}
    >
      <div className="flex max-h-80 flex-col gap-2 overflow-y-auto p-3 text-xs text-slate-600">
        {traces.length === 0 ? (
          <p className="text-[11px] text-slate-400">No trace data yet. Run a planner or actor flow to populate this view.</p>
        ) : (
          traces.map(({ traceId, events, summary }) => (
            <TraceSection key={traceId} traceId={traceId} events={events} summary={summary} />
          ))
        )}
      </div>
    </DesktopWindow>
  );
};

export default AgentTraceWindow;
