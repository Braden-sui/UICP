export type TelemetryEventName =
  | 'planner_start'
  | 'planner_finish'
  | 'actor_start'
  | 'actor_finish'
  | 'collect_timeout'
  | 'tool_args_parsed'
  | 'json_text_parsed'
  | 'wil_fallback'
  | 'enqueue_applied'
  | 'queue_dropped_idempotent'
  | 'batch_duplicate_skipped'
  | 'permissions_prompt'
  | 'permissions_allow'
  | 'permissions_deny'
  | 'api_call';

export type TraceSpan = 'planner' | 'actor' | 'collector' | 'queue' | 'batch' | 'permissions' | 'api';

export type TraceEventStatus = 'ok' | 'error' | 'timeout' | 'prompt' | 'dropped' | 'skipped';

export type TraceEventKind = 'span_start' | 'span_finish' | 'instant';

export type TraceEvent = {
  id: string;
  traceId: string;
  name: TelemetryEventName;
  timestamp: number;
  kind: TraceEventKind;
  span?: TraceSpan;
  durationMs?: number;
  status?: TraceEventStatus;
  data?: Record<string, unknown>;
};

export type TelemetryEventPayload = {
  traceId: string;
  timestamp?: number;
  span?: TraceSpan;
  durationMs?: number;
  status?: TraceEventStatus;
  data?: Record<string, unknown>;
  kind?: TraceEventKind;
};
