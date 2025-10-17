import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { createOllamaAggregator } from '../uicp/stream';
import { enqueueBatch, addQueueAppliedListener } from '../uicp/queue';
import { finalEventSchema, type JobSpec, type ComputeFinalEvent } from '../../compute/types';
import { useComputeStore } from '../../state/compute';
import { useAppStore } from '../../state/app';
import { useChatStore } from '../../state/chat';
import { createId } from '../../lib/utils';
import { ComputeError } from '../compute/errors';
import { asStatePath, type Batch } from '../uicp/schemas';
import { OrchestratorEvent } from '../orchestrator/state-machine';
import { type Result, createBridgeUnavailableError, toUICPError, UICPErrorCode } from './result';

let started = false;
let unsubs: UnlistenFn[] = [];

const getBridgeWindow = () => (typeof window === 'undefined' ? undefined : window);

export const hasTauriBridge = (): boolean => {
  const w = getBridgeWindow() as (Window & {
    __TAURI_INTERNALS__?: unknown;
    isTauri?: unknown;
  }) | undefined;
  // Tauri v2 uses __TAURI_INTERNALS__
  if (w?.__TAURI_INTERNALS__ !== undefined) return true;
  // Check for isTauri property (set by Tauri runtime)
  if (w?.isTauri === true) return true;
  // Legacy check for tests
  const mocks = (globalThis as Record<string, unknown>).__TAURI_MOCKS__ as
    | { invokeMock?: unknown }
    | undefined;
  return typeof mocks?.invokeMock === 'function';
};

export const tauriInvoke = async <T>(command: string, args?: unknown): Promise<T> => {
  if (!hasTauriBridge()) {
    throw new Error(`Tauri bridge unavailable for command ${command}`);
  }
  return invoke<T>(command, args as never);
};

// WHY: Universal invoke wrapper that returns Result<T, UICPError> for standardized error handling.
// INVARIANT: All errors are tagged with E-UICP-xxx codes for consistent telemetry and debugging.
// USAGE: const result = await inv<YourType>('command_name', { args }); if (!result.ok) handle(result.error);
export const inv = async <T>(command: string, args?: unknown): Promise<Result<T>> => {
  if (!hasTauriBridge()) {
    return { ok: false, error: createBridgeUnavailableError(command) };
  }
  
  try {
    const value = await invoke<T>(command, args as never);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: toUICPError(error, UICPErrorCode.InvokeFailed) };
  }
};

type OllamaEvent = {
  done?: boolean;
  delta?: unknown;
  kind?: string;
  error?: {
    status?: number;
    code?: string;
    detail?: string;
    requestId?: string;
    retryAfterMs?: number;
  };
};

export async function initializeTauriBridge() {
  if (started) return;

  const bridgeWindow = getBridgeWindow();
  if (!bridgeWindow) return;

  // Frontend debug event emitter for LogsPanel
  const emitUiDebug = (event: string, extra?: Record<string, unknown>) => {
    try {
      bridgeWindow.dispatchEvent(
        new CustomEvent('ui-debug-log', {
          detail: { ts: Date.now(), event, ...(extra || {}) },
        }),
      );
    } catch (error) {
      console.error(`Failed to emit ui-debug-log event ${event}:`, error instanceof Error ? error.message : String(error));
    }
  };

  // Compute plane: partials + finals support
  const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes
  let lastPendingPrune = 0;
  const pendingBinds = new Map<string, { task: string; binds: { toStatePath: string }[]; ts: number }>();
  const prunePending = () => {
    const now = Date.now();
    // Avoid frequent scans
    if (now - lastPendingPrune < 60_000) return; // 1 minute
    lastPendingPrune = now;
    for (const [id, rec] of pendingBinds.entries()) {
      if (now - rec.ts > PENDING_TTL_MS) {
        const ageMs = now - rec.ts;
        if (import.meta.env.DEV) {
          console.debug('[compute.pending] pruning orphan', { jobId: id, ageMs });
        }
        emitUiDebug('compute_pending_prune', { jobId: id, ageMs });
        pendingBinds.delete(id);
      }
    }
  };

  function applyFinalEvent(final: ComputeFinalEvent) {
    const entry = pendingBinds.get(final.jobId);
    if (!final.ok) {
      const toast = formatComputeErrorToast(final);
      useAppStore.getState().pushToast(toast);
      useChatStore.getState().pushSystemMessage(toast.message, 'compute_final_error');
      const m = final.metrics;
      useComputeStore.getState().markFinal(
        final.jobId,
        false,
        {
          durationMs: m?.durationMs,
          fuelUsed: m?.fuelUsed,
          memPeakMb: m?.memPeakMb,
          cacheHit: m?.cacheHit,
          deadlineMs: m?.deadlineMs,
          remainingMsAtFinish: m?.remainingMsAtFinish,
          logCount: m?.logCount,
          emittedLogBytes: m?.emittedLogBytes,
          partialFrames: m?.partialFrames,
          invalidPartialsDropped: m?.invalidPartialsDropped,
          logThrottleWaits: m?.logThrottleWaits,
          loggerThrottleWaits: m?.loggerThrottleWaits,
          partialThrottleWaits: m?.partialThrottleWaits,
        },
        final.message,
        final.code,
      );
      pendingBinds.delete(final.jobId);
      return;
    }
    if (entry && entry.binds && entry.binds.length) {
      const batch = entry.binds.map((b) => ({
        op: 'state.set',
        params: {
          scope: 'workspace',
          key: asStatePath(b.toStatePath),
          value: final.output,
        },
      } as const));
      enqueueBatch(batch).then((outcome) => {
        if (!outcome.success) {
          console.error('Failed to apply compute bindings', outcome.errors);
          useAppStore.getState().pushToast({ variant: 'error', message: 'Failed to apply compute results' });
        }
      });
    }
    const meta = final.metrics;
    useComputeStore.getState().markFinal(final.jobId, true, {
      durationMs: meta?.durationMs,
      fuelUsed: meta?.fuelUsed,
      memPeakMb: meta?.memPeakMb,
      cacheHit: meta?.cacheHit,
      deadlineMs: meta?.deadlineMs,
      remainingMsAtFinish: meta?.remainingMsAtFinish,
      logCount: meta?.logCount,
      emittedLogBytes: meta?.emittedLogBytes,
      partialFrames: meta?.partialFrames,
      invalidPartialsDropped: meta?.invalidPartialsDropped,
      logThrottleWaits: meta?.logThrottleWaits,
      loggerThrottleWaits: meta?.loggerThrottleWaits,
      partialThrottleWaits: meta?.partialThrottleWaits,
    });
    pendingBinds.delete(final.jobId);
  }

  function setupTestComputeFallback(
    targetWindow: Window,
    computeFn: (spec: JobSpec) => Promise<unknown>,
    cancelFn?: (jobId: string) => void,
  ) {
    targetWindow.uicpComputeCall = async (spec: JobSpec) => {
      try {
        pendingBinds.set(spec.jobId, { task: spec.task, binds: spec.bind ?? [], ts: Date.now() });
        prunePending();
        useComputeStore.getState().upsertJob({ jobId: spec.jobId, task: spec.task, status: 'running' });
        const finalSpec: JobSpec = { ...spec, workspaceId: spec.workspaceId ?? 'default' };
        const final = await computeFn(finalSpec);
        const parsed = finalEventSchema.safeParse(final);
        if (!parsed.success) {
          throw new Error('Test compute stub returned invalid final payload');
        }
        applyFinalEvent(parsed.data);
      } catch (error) {
        pendingBinds.delete(spec.jobId);
        useComputeStore
          .getState()
          .markFinal(
            spec.jobId,
            false,
            undefined,
            error instanceof Error ? error.message : String(error),
            ComputeError.CapabilityDenied,
          );
        throw error;
      }
    };
    targetWindow.uicpComputeCancel = async (jobId: string) => {
      try {
        cancelFn?.(jobId);
      } catch (error) {
        console.error(`Compute cancellation failed for job ${jobId}:`, error instanceof Error ? error.message : String(error));
      }
    };
  }

  // If not running inside Tauri, no-op gracefully.
  if (!hasTauriBridge()) {
    const testCompute = bridgeWindow.__UICP_TEST_COMPUTE__;
    if (typeof testCompute === 'function') {
      started = true;
      const testCancel =
        typeof bridgeWindow.__UICP_TEST_COMPUTE_CANCEL__ === 'function'
          ? bridgeWindow.__UICP_TEST_COMPUTE_CANCEL__
          : undefined;
      setupTestComputeFallback(bridgeWindow, testCompute, testCancel);
    }
    return;
  }
  started = true;

  // Expose compute helpers immediately to avoid races with async listener setup.
  bridgeWindow.uicpComputeCall = async (spec: JobSpec) => {
    try {
      pendingBinds.set(spec.jobId, { task: spec.task, binds: spec.bind ?? [], ts: Date.now() });
      prunePending();
      useComputeStore.getState().upsertJob({ jobId: spec.jobId, task: spec.task, status: 'running' });
      const finalSpec: JobSpec = { ...spec, workspaceId: spec.workspaceId ?? 'default' };
      await invoke('compute_call', { spec: finalSpec });
    } catch (error) {
      pendingBinds.delete(spec.jobId);
      useComputeStore.getState().markFinal(spec.jobId, false, undefined, undefined, ComputeError.CapabilityDenied);
      throw error;
    }
  };

  bridgeWindow.uicpComputeCancel = async (jobId: string) => {
    try {
      await invoke('compute_cancel', { jobId });
    } catch (error) {
      console.error(`Compute cancellation invoke failed for job ${jobId}:`, error instanceof Error ? error.message : String(error));
    }
  };

  // Dev-only: enable backend debug logs and mirror key events to DevTools
  if (import.meta.env.DEV) {
    try {
      await invoke('set_debug', { enabled: true });
    } catch (error) {
      console.error('Failed to enable debug mode:', error instanceof Error ? error.message : String(error));
    }

    // Mirror backend debug events
    unsubs.push(
      await listen('debug-log', (event) => {
        const payload = event.payload as unknown;
        try {
          const obj = typeof payload === 'string' ? JSON.parse(payload as string) : payload;
          const rec = obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : {};
          const ev = typeof rec['event'] === 'string' ? (rec['event'] as string) : 'debug-log';
          // Rate-limit backoff status toast (dev visibility): retry countdown and "retrying now"
          if (ev === 'retry_backoff') {
            const waitMs = Number(rec['waitMs'] ?? 0) || 0;
            const rid = typeof rec['requestId'] === 'string' ? ` req=${rec['requestId'] as string}` : '';
            const secs = Math.ceil(waitMs / 1000);
            useAppStore.getState().pushToast({ variant: 'info', message: `[Rate limit] Retrying in ${secs}s${rid}` });
            if (waitMs > 0) {
              setTimeout(() => {
                useAppStore.getState().pushToast({ variant: 'info', message: `[Rate limit] Retrying now${rid}` });
              }, Math.min(waitMs, 15000));
            }
          }
          // Forward compute guest stdio/log debug events into UI debug bus as compute_log
          if (ev === 'compute_guest_stdio' || ev === 'compute_guest_log') {
            const jobId = rec.jobId as string | undefined;
            const task = rec.task as string | undefined;
            const channel = rec.channel as string | undefined;
            const level = rec.level as string | undefined;
            const message = rec.message as string | undefined;
            emitUiDebug('compute_log', {
              jobId,
              task,
              stream: channel ?? 'wasi-logging',
              level,
              message,
            });
          }
          console.debug(`[tauri:${String(ev)}]`, obj);
        } catch {
          console.debug('[tauri:debug-log]', payload);
        }
      }),
    );

    // Mirror stream chunk sizes without altering aggregator behaviour
    unsubs.push(
      await listen('ollama-completion', (event) => {
        const payload = event.payload as OllamaEvent | undefined;
        if (!payload) return;
        if (payload.done) {
          console.info('[ollama] done');
        } else if (payload.delta !== undefined) {
          const isStr = typeof payload.delta === 'string';
          const len = isStr ? (payload.delta as string).length : JSON.stringify(payload.delta).length;
          console.debug(`[ollama:${payload.kind ?? (isStr ? 'text' : 'json')}] len=${len}`);
        }
      }),
    );
  }

  let aggregatorFailed = false;
  let currentTraceId: string | null = null;
  // Concurrency guard for overlapping streams
  let streamGen = 0;
  let activeStream = 0;
  const handleAggregatorError = (error: unknown) => {
    if (aggregatorFailed) return;
    aggregatorFailed = true;
    const message = error instanceof Error ? error.message : String(error);
    console.error('ollama aggregator failed', { error: message, traceId: currentTraceId ?? undefined });
    const appState = useAppStore.getState();
    appState.setStreaming(false);
    appState.pushToast({ variant: 'error', message: `Streaming apply failed: ${message}` });
    const suffix = currentTraceId ? ` (trace: ${currentTraceId})` : '';
    useChatStore.getState().pushSystemMessage(`Failed to apply streaming batch: ${message}${suffix}`, 'ollama_stream_error');
  };

  // Factory to create a new aggregator that respects Full Control and preview gating.
  const applyAggregatedBatch = async (batch: Batch) => {
    const app = useAppStore.getState();

    // WHY: Check if orchestrator-managed run is in flight using state machine
    // INVARIANT: suppressAutoApply takes precedence for backward compatibility during transition
    if (app.suppressAutoApply) {
      if (import.meta.env.DEV) {
        console.debug('[aggregator] skipping batch due to suppressAutoApply');
      }
      return;
    }

    // WHY: Use state machine to determine if auto-apply is allowed
    // INVARIANT: Only auto-apply when state machine and Full Control flags both allow it
    const canAutoApply = app.canAutoApply();

    if (canAutoApply) {
      // WHY: Transition to Applying state before executing batch
      const transition = app.transitionOrchestrator(OrchestratorEvent.StartApplying, {
        batchSize: batch.length,
        source: 'aggregator',
      });

      if (transition && import.meta.env.DEV) {
        console.debug('[aggregator] auto-applying batch', {
          batchSize: batch.length,
          runId: app.orchestratorContext.runId,
          transition: { from: transition.from, to: transition.to },
        });
      }

      try {
        const outcome = await enqueueBatch(batch);
        if (!outcome.success) {
          throw new Error(outcome.errors.join('; ') || 'enqueueBatch failed');
        }

        // WHY: Transition to Idle after successful apply
        app.transitionOrchestrator(OrchestratorEvent.ApplyComplete, {
          applied: outcome.applied,
        });

        return outcome;
      } catch (error) {
        // WHY: On error, transition to Cancelled state
        app.transitionOrchestrator(OrchestratorEvent.Cancel, {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    // WHY: Cannot auto-apply, so show preview
    if (import.meta.env.DEV) {
      console.debug('[aggregator] showing preview', {
        batchSize: batch.length,
        fullControl: app.fullControl,
        fullControlLocked: app.fullControlLocked,
        runId: app.orchestratorContext.runId,
      });
    }

    const chat = useChatStore.getState();
    if (!chat.pendingPlan) {
      useChatStore.setState({
        pendingPlan: {
          id: createId('plan'),
          summary: 'Generated plan',
          batch,
        },
      });
    }
  };

  const makeAggregator = () => createOllamaAggregator(applyAggregatedBatch);

  // Map backend error payloads into a consistent toast format.
  const formatOllamaErrorToast = (
    err: { status?: number; code?: string; detail?: string; requestId?: string; retryAfterMs?: number },
    traceId?: string | null,
  ): { variant: 'error' | 'info' | 'success'; message: string } => {
    const code = err.code ?? (err.status ? String(err.status) : 'Error');
    const rid = err.requestId ? ` req=${err.requestId}` : '';
    const tid = traceId ? ` trace=${traceId}` : '';
    const retry = err.retryAfterMs ? ` retryIn=${Math.round(err.retryAfterMs)}ms` : '';
    const label =
      code === 'RequestTimeout'
        ? '[Timeout]'
        : code === 'CircuitOpen'
          ? '[Unavailable]'
          : code === 'TransportError'
            ? '[Network]'
            : code === 'UpstreamFailure'
              ? '[Upstream]'
              : code === 'StreamError'
                ? '[Stream]'
                : `[${code}]`;
    const detail = err.detail ?? 'Request failed';
    return { variant: 'error', message: `${label} ${detail}${rid}${tid}${retry}` };
  };

  // Compute error toast formatter: labels by code + concise metrics summary.
  const formatComputeErrorToast = (
    final: {
      jobId: string;
      task: string;
      code: string;
      message?: string;
      metrics?: { durationMs?: number; fuelUsed?: number; memPeakMb?: number; cacheHit?: boolean };
    },
  ): { variant: 'error' | 'info' | 'success'; message: string } => {
    const code = final.code;
    const label =
      code === 'Compute.Timeout'
        ? '[Timeout]'
        : code === 'Compute.Cancelled'
          ? '[Cancelled]'
          : code === 'Compute.CapabilityDenied'
            ? '[Denied]'
            : code === 'Compute.Resource.Limit'
              ? '[Resource]'
              : code === 'Runtime.Fault'
                ? '[Runtime]'
                : code === 'Task.NotFound'
                  ? '[NotFound]'
                  : code === 'IO.Denied'
                    ? '[IO]'
                    : code === 'Compute.Input.Invalid'
                      ? '[Input]'
                      : code === 'Nondeterministic'
                        ? '[Nondet]'
                        : `[${code}]`;
    const m = final.metrics;
    const parts: string[] = [];
    if (typeof m?.durationMs === 'number') parts.push(`dur=${Math.round(m.durationMs)}ms`);
    if (typeof m?.fuelUsed === 'number') parts.push(`fuel=${m.fuelUsed}`);
    if (typeof m?.memPeakMb === 'number') parts.push(`mem=${m.memPeakMb}MB`);
    if (typeof m?.cacheHit === 'boolean') parts.push(`cache=${m.cacheHit ? 'hit' : 'miss'}`);
    const metrics = parts.length ? ` ${parts.join(' ')}` : '';
    const detail = final.message ? ` - ${final.message}` : '';
    const msg = `${label} ${final.task} ${final.code}${detail} (job ${final.jobId})${metrics}`;
    return { variant: 'error', message: msg };
  };

  // Per-stream aggregators keyed by generation
  const aggregators = new Map<number, ReturnType<typeof createOllamaAggregator>>();
  // Ensure cleanup on teardown
  unsubs.push(() => aggregators.clear());

  

  const offApplied = addQueueAppliedListener(({ windowId, applied, ms }) => {
    const tag = windowId && windowId !== '__global__' ? ` [${windowId}]` : '';
    useAppStore.getState().pushToast({ variant: 'success', message: `Applied ${applied} commands in ${Math.round(ms)} ms${tag}` });
    emitUiDebug('queue_applied', { windowId, applied, ms: Math.round(ms) });
  });
  unsubs.push(offApplied);

  unsubs.push(
    await listen('save-indicator', (event) => {
      const payload = event.payload as { ok?: boolean; timestamp?: number } | undefined;
      if (!payload) return;
      if (payload.ok === false) {
        useAppStore.getState().pushToast({ variant: 'error', message: 'Autosave failed. Changes may not persist.' });
      }
    }),
  );

  // Health and Safe Mode
  unsubs.push(
    await listen('replay-issue', (event) => {
      const payload = event.payload as { reason?: string; action?: string } | undefined;
      const reason = payload?.reason ?? 'Unknown';
      // Extend store at runtime to avoid breaking tests if fields not present.
      try {
        useAppStore.getState().setSafeMode(true, reason);
      } catch (err) {
        console.error('failed to set safe mode', err);
      }
      useAppStore.getState().pushToast({ variant: 'error', message: `Replay issue detected: ${reason}` });
    }),
  );

  unsubs.push(
    await listen('api-key-status', (event) => {
      const payload = event.payload as { valid: boolean; message?: string } | undefined;
      if (!payload) return;
      const msg = payload.message ?? (payload.valid ? 'API key OK' : 'API key invalid');
      useAppStore.getState().pushToast({ variant: payload.valid ? 'success' : 'error', message: msg });
    }),
  );

  unsubs.push(
    await listen('ollama-completion', async (event) => {
      const payload = event.payload as OllamaEvent | undefined;
      if (!payload) return;
      if (payload.done) {
        // Ignore stale completions from a superseded stream
        if (activeStream !== streamGen) return;
        const agg = aggregators.get(activeStream);
        if (!agg) return;
        const maybeErr = (event.payload as OllamaEvent | undefined)?.error;
        if (maybeErr) {
          const toast = formatOllamaErrorToast(maybeErr, currentTraceId);
          useAppStore.getState().pushToast(toast);
          useChatStore
            .getState()
            .pushSystemMessage(`Chat error ${toast.message}`, 'ollama_stream_error');
          const waitMs = typeof maybeErr.retryAfterMs === 'number' ? maybeErr.retryAfterMs! : 0;
          if (waitMs > 0) {
            const secs = Math.ceil(waitMs / 1000);
            const rid = maybeErr.requestId ? ` req=${maybeErr.requestId}` : '';
            const tid = currentTraceId ? ` trace=${currentTraceId}` : '';
            useAppStore
              .getState()
              .pushToast({ variant: 'info', message: `[Rate limit] Try again in ${secs}s${rid}${tid}` });
            setTimeout(() => {
              useAppStore
                .getState()
                .pushToast({ variant: 'info', message: `[Rate limit] You can try again now${rid}${tid}` });
            }, Math.min(waitMs, 15000));
          }
        }
        let flushed = false;
        let wasCancelled = false;
        try {
          const flushResult = await agg.flush();
          flushed = !flushResult?.cancelled;
          wasCancelled = flushResult?.cancelled ?? false;
        } catch (error) {
          handleAggregatorError(error);
        }
        useAppStore.getState().setStreaming(false);
        if (flushed) {
          aggregatorFailed = false;
        }
        // WHY: Emit stream.closed event to signal stream termination with reason
        // INVARIANT: reason is 'user_cancel' if cancelled, 'normal' otherwise
        const closeReason = wasCancelled ? 'user_cancel' : 'normal';
        if (currentTraceId) {
          console.info('[ollama] stream finished', { traceId: currentTraceId, gen: activeStream, reason: closeReason });
          emitUiDebug('stream_finished', { traceId: currentTraceId, gen: activeStream, flushed, reason: closeReason });
          emitUiDebug('stream_closed', { traceId: currentTraceId, gen: activeStream, reason: closeReason });
          currentTraceId = null;
        }
        aggregators.delete(activeStream);
        return;
      }
      if (payload.delta !== undefined) {
        const text = typeof payload.delta === 'string' ? payload.delta : JSON.stringify(payload.delta);
        try {
          // Reset failure latch when a new stream starts so future runs can surface their own errors.
          if (!useAppStore.getState().streaming) {
            // WHY: Cancel previous stream if it exists to prevent ghost echoes
            const prevAgg = aggregators.get(activeStream);
            if (prevAgg) {
              prevAgg.cancel();
              if (import.meta.env.DEV) {
                console.debug('[ollama] cancelling superseded stream', { gen: activeStream });
              }
            }
            activeStream = ++streamGen;
            aggregatorFailed = false;
            currentTraceId = createId('trace');
            console.info('[ollama] stream started', { traceId: currentTraceId, gen: activeStream });
            emitUiDebug('stream_started', { traceId: currentTraceId, gen: activeStream });
            aggregators.set(activeStream, makeAggregator());
          }
          // Ignore stale deltas from a superseded stream
          if (activeStream !== streamGen) return;
          const agg = aggregators.get(activeStream);
          if (!agg) return;
          await agg.processDelta(text);
          useAppStore.getState().setStreaming(true);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          handleAggregatorError(error);
          console.error('[ollama] stream error', { traceId: currentTraceId, error: msg });
          emitUiDebug('stream_error', { traceId: currentTraceId ?? undefined, message: msg });
        }
      }
    }),
  );

  // Compute plane: debug telemetry for cancellations/timeouts
  unsubs.push(
    await listen('compute-debug', (event) => {
      const payload = event.payload as { jobId?: string; event?: string } | undefined;
      if (!payload) return;
      const jobId = String(payload.jobId ?? '');
      const ev = String(payload.event ?? '');
      if (ev === 'cancel_aborted_after_grace') {
        // Mark terminal cancelled so UI does not leak a running job
        useComputeStore.getState().markFinal(jobId, false, undefined, undefined, ComputeError.Cancelled);
      }
    }),
  );

  if (!bridgeWindow.__UICP_COMPUTE_STORE__) {
    Object.defineProperty(bridgeWindow, '__UICP_COMPUTE_STORE__', {
        value: useComputeStore,
        configurable: true,
        writable: false,
      });
  }
  if (!bridgeWindow.__UICP_APP_STORE__) {
    Object.defineProperty(bridgeWindow, '__UICP_APP_STORE__', {
        value: useAppStore,
        configurable: true,
        writable: false,
      });
  }

  unsubs.push(
    await listen('compute-result-final', async (event) => {
      const payload = event.payload as unknown;
      const parsed = finalEventSchema.safeParse(payload);
      if (!parsed.success) {
        console.error('Invalid compute final payload', parsed.error);
        return;
      }
      await applyFinalEvent(parsed.data);
    }),
  );

  // Bridge custom frontend intents to the chat pipeline so planner-built forms can trigger new runs.
  type IntentDetail = { text: string; windowId?: string };

  const handleIntent = async (detail: IntentDetail) => {
    const text = detail.text?.trim();
    if (!text) return;
    // Avoid double-run during orchestrator-managed flow
    const app = useAppStore.getState();
    if (app.suppressAutoApply) return;
    const chat = useChatStore.getState();
    // Merge with the most recent user ask so the planner has full context.
    const lastUser = [...chat.messages].reverse().find((m) => m.role === 'user')?.content;
    const merged = lastUser ? `${lastUser}\n\nAdditional details: ${text}` : text;
    await chat.sendMessage(merged);
  };

  const onIntent = (evt: Event) => {
    const detail = (evt as CustomEvent<IntentDetail>).detail;
    if (!detail) return;
    // Fire-and-forget to keep the DOM listener signature synchronous.
    void handleIntent(detail).catch((err) => {
      console.error('uicp-intent handler failed', err);
    });
  };

  bridgeWindow.addEventListener('uicp-intent', onIntent, false);
  unsubs.push(() => bridgeWindow.removeEventListener('uicp-intent', onIntent, false));
}

export function teardownTauriBridge() {
  for (const off of unsubs) {
    try {
      off();
    } catch (error) {
      console.error('Failed to unsubscribe event listener during teardown:', error instanceof Error ? error.message : String(error));
    }
  }
  unsubs = [];
  started = false;
  // Clear globals to avoid accidental reuse after teardown
  const bridgeWindow = getBridgeWindow();
  if (bridgeWindow) {
    bridgeWindow.uicpComputeCall = undefined;
    bridgeWindow.uicpComputeCancel = undefined;
  }
}
