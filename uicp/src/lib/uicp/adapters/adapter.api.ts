/**
 * API Scheme Routing
 * 
 * WHY: Handles all api.call operations with scheme-based routing (uicp://, tauri://, http(s)://).
 * INVARIANT: Each scheme handler returns CommandResult for consistent error handling.
 * SAFETY: URL validation and method allowlisting prevent abuse.
 */

import { createId } from "../../utils";
import { getComputeBridge } from "../../bridge/globals";
import { safeWrite, BaseDirectory } from "./adapter.fs";
import { emitTelemetryEvent } from "../../telemetry";
import type { OperationParamMap, Envelope } from "./schemas";
import { jobSpecSchema, type JobSpec } from "../../../compute/types";
import type { StructuredClarifierBody } from "./adapter.clarifier";
import { isStructuredClarifierBody } from "./adapter.clarifier";

// Derive options type from fetch so lint rules do not expect a RequestInit global at runtime.
type FetchRequestInit = NonNullable<Parameters<typeof fetch>[1]>;

const ALLOWED_BASE_DIRECTORIES: Record<string, BaseDirectory> = {
  AppConfig: BaseDirectory.AppConfig,
  AppData: BaseDirectory.AppData,
  AppLocalData: BaseDirectory.AppLocalData,
  Document: BaseDirectory.Document,
  Desktop: BaseDirectory.Desktop,
  Download: BaseDirectory.Download,
};

const DEFAULT_EXPORT_DIRECTORY = BaseDirectory.AppData;
const ALLOWED_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH']);

type CommandResult<T = unknown, D = unknown> =
  | { success: true; value: T; data?: D }
  | { success: false; error: string };

const toFailure = (error: unknown): CommandResult<never> => ({
  success: false,
  error: error instanceof Error ? error.message : String(error),
});

type ApplyContext = {
  runId?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  return isRecord(value) ? value : undefined;
};

/**
 * Handles uicp://compute.call requests.
 * 
 * WHY: Routes compute job submissions to the compute bridge.
 * INVARIANT: JobSpec must contain jobId and task fields.
 */
const handleComputeCall = async (
  params: OperationParamMap["api.call"],
  command: Envelope,
  ctx: ApplyContext,
): Promise<CommandResult<string>> => {
  try {
    const rawBody = isRecord(params.body) ? params.body : {};
    const provenanceRecord = isRecord(rawBody.provenance) ? rawBody.provenance : undefined;
    const rawEnvHash = typeof provenanceRecord?.envHash === 'string' ? provenanceRecord.envHash.trim() : '';
    const envHash = rawEnvHash || 'adapter.api@v2';
    const rawAgent = typeof provenanceRecord?.agentTraceId === 'string' ? provenanceRecord.agentTraceId.trim() : '';
    const fallbackTrace = ctx.runId ?? command.traceId;
    const agentTraceId = rawAgent || (fallbackTrace ? fallbackTrace : undefined);

    const normalizedBody: Record<string, unknown> = {
      ...rawBody,
      provenance: agentTraceId ? { envHash, agentTraceId } : { envHash },
    };

    const parsed = jobSpecSchema.safeParse(normalizedBody);
    if (!parsed.success) {
      return { success: false, error: `Compute job spec invalid: ${parsed.error.message}` };
    }

    const computeCall = getComputeBridge();
    if (!computeCall) throw new Error('compute bridge not initialized');

    const spec = parsed.data as JobSpec;
    const finalSpec: JobSpec = {
      ...spec,
      workspaceId: spec.workspaceId ?? 'default',
    };

    await computeCall(finalSpec);
    return { success: true, value: params.idempotencyKey ?? createId('api') };
  } catch (error) {
    console.error('compute.call failed', error);
    return toFailure(error);
  }
};

/**
 * Handles tauri://fs/writeTextFile requests.
 * 
 * WHY: Provides safe file writing with directory restrictions.
 * INVARIANT: Desktop writes require explicit dev mode approval.
 */
const handleTauriFs = async (
  params: OperationParamMap["api.call"],
  ctx: ApplyContext,
  command: Envelope,
): Promise<CommandResult<string>> => {
  const body = (params.body ?? {}) as Record<string, unknown>;
  const path = String(body.path ?? 'uicp.txt');
  const contents = String(body.contents ?? '');
  const dirToken =
    typeof body.directory === 'string' && body.directory.trim().length > 0
      ? body.directory.trim()
      : undefined;
  const dir = (dirToken ? ALLOWED_BASE_DIRECTORIES[dirToken] : undefined) ?? DEFAULT_EXPORT_DIRECTORY;
  const safeResult = await safeWrite(path, contents, {
    base: dir,
    devDesktopWrite: dir === BaseDirectory.Desktop,
    runId: ctx.runId ?? command.traceId,
  });
  if (!safeResult.ok) {
    const logPayload = { path, directory: dirToken, errorCode: safeResult.errorCode };
    if (dir === BaseDirectory.Desktop) {
      console.warn('desktop export blocked', logPayload);
    } else {
      console.error('tauri fs write failed', logPayload);
    }
    return { success: false, error: safeResult.message };
  }
  // This line is never reached; success returns inside try
  // Keep for type consistency
  return { success: true, value: params.idempotencyKey ?? createId('api') };
};

/**
 * Handles uicp://intent requests.
 * 
 * WHY: Routes user intents back to orchestrator or renders structured clarifier forms.
 * INVARIANT: Structured clarifiers bypass normal intent dispatch.
 */
const handleIntent = async (
  params: OperationParamMap["api.call"],
  command: Envelope,
  renderStructuredClarifierForm: (body: StructuredClarifierBody, command: Envelope) => CommandResult<string>,
): Promise<CommandResult<string>> => {
  const rawBody = asRecord(params.body) ?? {};
  if (isStructuredClarifierBody(rawBody)) {
    return renderStructuredClarifierForm(rawBody, command);
  }
  try {
    const text = typeof rawBody.text === 'string' ? rawBody.text : '';
    const meta = { windowId: (rawBody.windowId as string | undefined) ?? command.windowId };
    if (text.trim()) {
      const evt = new CustomEvent('uicp-intent', { detail: { text, ...meta } });
      window.dispatchEvent(evt);
    }
  } catch (err) {
    console.error('uicp://intent dispatch failed', err);
  }
  return { success: true, value: params.idempotencyKey ?? createId('api') };
};

/**
 * Handles http(s):// requests.
 * 
 * WHY: Provides fetch-based HTTP client with telemetry and method validation.
 * INVARIANT: Only allowed HTTP methods (GET, POST, PUT, DELETE, HEAD, PATCH) permitted.
 */
const handleHttpFetch = async (
  params: OperationParamMap["api.call"],
  command: Envelope,
): Promise<CommandResult<string>> => {
  const url = params.url;
  const method = (params.method ?? 'GET').toUpperCase();
  const traceId = command.traceId;
  const urlObj = new URL(url);

  if (!ALLOWED_HTTP_METHODS.has(method)) {
    if (traceId) {
      emitTelemetryEvent('api_call', {
        traceId,
        span: 'api',
        status: 'error',
        data: { reason: 'method_not_allowed', method, origin: urlObj.origin },
      });
    }
    return { success: false, error: `Method ${method} not allowed` };
  }

  const init: FetchRequestInit = { method, headers: params.headers };
  if (params.body !== undefined) {
    try {
      init.body = typeof params.body === 'string' ? params.body : JSON.stringify(params.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (traceId) {
        emitTelemetryEvent('api_call', {
          traceId,
          span: 'api',
          status: 'error',
          data: { reason: 'body_serialization_failed', method, origin: urlObj.origin, error: message },
        });
      }
      return { success: false, error: 'Body serialization failed' };
    }
    init.headers = { 'content-type': 'application/json', ...(params.headers ?? {}) };
  }

  const startedAt = performance.now();
  try {
    const response = await fetch(url, init);
    const duration = Math.round(performance.now() - startedAt);
    if (traceId) {
      emitTelemetryEvent('api_call', {
        traceId,
        span: 'api',
        durationMs: duration,
        status: response.ok ? 'ok' : 'error',
        data: {
          method,
          origin: urlObj.origin,
          pathname: urlObj.pathname,
          status: response.status,
        },
      });
    }
    if (!response.ok) {
      const statusText = response.statusText?.trim();
      const label = statusText ? `${response.status} ${statusText}` : `${response.status}`;
      return { success: false, error: `HTTP ${label}` };
    }
    // Parse response body into data for state sinks
    let data: unknown = null;
    try {
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        data = await response.json();
      } else if (contentType.startsWith('text/')) {
        data = await response.text();
      } else {
        // For non-text, non-json responses, leave data as null (not supported)
        data = null;
      }
    } catch {
      // Swallow body parse errors; deliver OK without data
      data = null;
    }
    const baseResult: CommandResult<string> = { success: true, value: params.idempotencyKey ?? createId('api') };
    return data !== undefined ? { ...baseResult, data } : baseResult;
  } catch (error) {
    const duration = Math.round(performance.now() - startedAt);
    const message = error instanceof Error ? error.message : String(error);
    if (traceId) {
      emitTelemetryEvent('api_call', {
        traceId,
        span: 'api',
        durationMs: duration,
        status: 'error',
        data: {
          method,
          origin: urlObj.origin,
          pathname: urlObj.pathname,
          error: message,
        },
      });
    }
    console.error('api.call fetch failed', { traceId, url, error: message });
    return toFailure(error);
  }
};

/**
 * Main API routing dispatcher.
 * 
 * WHY: Single entry point for all api.call operations ensures consistent scheme handling.
 * INVARIANT: Routes by URL scheme prefix (uicp://, tauri://, http(s)://).
 * 
 * @param params - api.call parameters
 * @param command - Full envelope for context
 * @param ctx - Apply context with runId
 * @param renderStructuredClarifierForm - Clarifier renderer function
 * @returns CommandResult with success/error
 */
export const routeApiCall = async (
  params: OperationParamMap["api.call"],
  command: Envelope,
  ctx: ApplyContext,
  renderStructuredClarifierForm: (body: StructuredClarifierBody, command: Envelope) => CommandResult<string>,
): Promise<CommandResult<string>> => {
  try {
    const url = params.url;
    
    // UICP compute plane submission: uicp://compute.call (body = JobSpec)
    if (url.startsWith('uicp://compute.call')) {
      return await handleComputeCall(params, command, ctx);
    }
    
    // Tauri FS special-case
    if (url.startsWith('tauri://fs/writeTextFile')) {
      return await handleTauriFs(params, ctx, command);
    }
    
    // UICP intent dispatch: hand off to app chat pipeline
    if (url.startsWith('uicp://intent')) {
      return await handleIntent(params, command, renderStructuredClarifierForm);
    }
    
    // Basic fetch for http(s)
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return await handleHttpFetch(params, command);
    }
    
    // Unknown scheme: treat as no-op success for now
    return { success: true, value: params.idempotencyKey ?? createId('api') };
  } catch (error) {
    return toFailure(error);
  }
};

// Re-export types for external use
// Clarifier helpers re-exported for compatibility
export type { StructuredClarifierBody } from "./adapter.clarifier";
