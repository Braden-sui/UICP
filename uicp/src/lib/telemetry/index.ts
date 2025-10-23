import { useAppStore } from '../../state/app';
import { createId } from '../utils';
import type {
  TelemetryEventName,
  TelemetryEventPayload,
  TraceEvent,
  TraceEventKind,
  TraceEventStatus,
  TraceSpan,
} from './types';

type EventDefaults = Partial<{
  span: TraceSpan;
  kind: TraceEventKind;
  status: TraceEventStatus;
}>;

const EVENT_DEFAULTS: Partial<Record<TelemetryEventName, EventDefaults>> = {
  planner_start: { span: 'planner', kind: 'span_start' },
  planner_finish: { span: 'planner', kind: 'span_finish', status: 'ok' },
  actor_start: { span: 'actor', kind: 'span_start' },
  actor_finish: { span: 'actor', kind: 'span_finish', status: 'ok' },
  collect_timeout: { span: 'collector', kind: 'instant', status: 'timeout' },
  tool_args_parsed: { kind: 'instant' },
  json_text_parsed: { kind: 'instant' },
  wil_fallback: { kind: 'instant', span: 'actor' },
  enqueue_applied: { span: 'queue', kind: 'instant', status: 'ok' },
  queue_dropped_idempotent: { span: 'queue', kind: 'instant', status: 'dropped' },
  batch_duplicate_skipped: { span: 'batch', kind: 'instant', status: 'skipped' },
  batch_lint_rejected: { span: 'queue', kind: 'instant', status: 'error' },
  permissions_prompt: { span: 'permissions', kind: 'instant', status: 'prompt' },
  permissions_allow: { span: 'permissions', kind: 'instant', status: 'ok' },
  permissions_deny: { span: 'permissions', kind: 'instant', status: 'error' },
  safe_write: { span: 'fs', kind: 'instant' },
  api_call: { span: 'api', kind: 'instant' },
  'adapter.apply.start': { span: 'batch', kind: 'span_start' },
  'adapter.apply.end': { span: 'batch', kind: 'span_finish' },
  'adapter.apply.abort': { span: 'batch', kind: 'instant', status: 'error' },
  'adapter.window.create': { span: 'batch', kind: 'instant' },
  'adapter.window.update': { span: 'batch', kind: 'instant' },
  'adapter.window.close': { span: 'batch', kind: 'instant' },
  'adapter.dom.apply': { span: 'batch', kind: 'instant' },
  'adapter.component.render': { span: 'batch', kind: 'instant' },
  'adapter.component.unknown': { span: 'batch', kind: 'instant' },
  'adapter.permission.check': { span: 'permissions', kind: 'instant' },
  'adapter.permission.denied': { span: 'permissions', kind: 'instant', status: 'error' },
  'adapter.validation.error': { span: 'batch', kind: 'instant', status: 'error' },
  'adapter.dedupe.skip': { span: 'batch', kind: 'instant', status: 'skipped' },
  'adapter.ui.command': { span: 'batch', kind: 'instant' },
  needs_code_artifact: { span: 'compute', kind: 'instant', status: 'ok' },
  provider_decision: { span: 'compute', kind: 'instant' },
  'ui.anim.window.enter': { span: 'ui', kind: 'instant', status: 'ok' },
  'ui.anim.window.exit': { span: 'ui', kind: 'instant', status: 'ok' },
  'ui.anim.panel.enter': { span: 'ui', kind: 'instant', status: 'ok' },
  'ui.anim.panel.exit': { span: 'ui', kind: 'instant', status: 'ok' },
  'ui.anim.frame_drop': { span: 'ui', kind: 'instant', status: 'error' },
};

const sanitizeData = (input: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
  if (!input) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (value === null) {
      out[key] = null;
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.slice(0, 10).map((item) => (typeof item === 'object' ? JSON.stringify(item) : item));
      continue;
    }
    if (typeof value === 'object') {
      try {
        out[key] = JSON.parse(JSON.stringify(value));
      } catch {
        out[key] = String(value);
      }
      continue;
    }
    out[key] = String(value);
  }
  return out;
};

export const emitTelemetryEvent = (name: TelemetryEventName, payload: TelemetryEventPayload): void => {
  const traceId = payload.traceId?.trim();
  if (!traceId) {
    throw new Error(`E-UICP-1201 telemetry event ${name} missing traceId`);
  }

  const defaults = EVENT_DEFAULTS[name] ?? {};
  const timestamp = payload.timestamp ?? Date.now();
  const kind = payload.kind ?? defaults.kind ?? 'instant';
  const span = payload.span ?? defaults.span;
  const status = payload.status ?? defaults.status;

  const event: TraceEvent = {
    id: createId('traceevt'),
    name,
    traceId,
    timestamp,
    kind,
    span,
    status,
    durationMs: payload.durationMs,
    data: sanitizeData(payload.data),
  };

  useAppStore.getState().recordTraceEvent(event);

  if (import.meta.env.DEV) {
    const { data, durationMs, span: eventSpan, status: eventStatus } = event;
    // WHY: Surface structured telemetry in dev console while guaranteeing traceId propagation.
    console.info(`[telemetry] ${name}`, {
      traceId,
      span: eventSpan,
      kind,
      status: eventStatus,
      durationMs,
      data,
    });
  }
};

export type { TelemetryEventName, TelemetryEventPayload, TraceEvent } from './types';
