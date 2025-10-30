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
  | 'llm_stream_start'
  | 'llm_stream_complete'
  | 'llm_stream_error'
  | 'provider_error_mapped'
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
  | 'provider_decision'
  | 'apply_handshake_start'
  | 'apply_handshake_ack'
  | 'router_provider_selected'
  | 'auth_preflight_result'
  | 'collector_source'
  | 'linter_reject'
  | 'ui.anim.window.enter'
  | 'ui.anim.window.exit'
  | 'ui.anim.panel.enter'
  | 'ui.anim.panel.exit'
  | 'ui.anim.frame.drop'
  | 'security.net_guard.block'
  | 'security.net_guard.rollout_state'
  // Resilience and circuit breaker events
  | 'resilience.retry_attempt'
  | 'resilience.circuit_opened'
  | 'resilience.circuit_closed'
  | 'resilience.circuit_half_open'
  | 'resilience.failure_injected'
  | 'resilience.failure_stopped'
  | 'resilience.provider_health_check'
  | 'resilience.metrics_summary';

export type TraceSpan = 'planner' | 'actor' | 'collector' | 'queue' | 'batch' | 'permissions' | 'api' | 'fs' | 'compute' | 'ui' | 'resilience';

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
