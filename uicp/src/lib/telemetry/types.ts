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
  | 'batch_lint_rejected'
  | 'permissions_prompt'
  | 'permissions_allow'
  | 'permissions_deny'
  | 'api_call'
  | 'safe_write'
  | 'adapter.apply.start'
  | 'adapter.apply.end'
  | 'adapter.apply.abort'
  | 'adapter.window.create'
  | 'adapter.window.update'
  | 'adapter.window.close'
  | 'adapter.dom.apply'
  | 'adapter.component.render'
  | 'adapter.component.unknown'
  | 'adapter.permission.check'
  | 'adapter.permission.denied'
  | 'adapter.validation.error'
  | 'adapter.dedupe.skip'
  | 'adapter.ui.command'
  | 'needs_code_artifact'
  | 'ui.anim.window.enter'
  | 'ui.anim.window.exit'
  | 'ui.anim.panel.enter'
  | 'ui.anim.panel.exit'
  | 'ui.anim.frame_drop';

export type TraceSpan = 'planner' | 'actor' | 'collector' | 'queue' | 'batch' | 'permissions' | 'api' | 'fs' | 'compute' | 'ui';

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
