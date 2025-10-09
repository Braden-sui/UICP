import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { createOllamaAggregator } from '../uicp/stream';
import { enqueueBatch, setQueueAppliedListener } from '../uicp/queue';
import { finalEventSchema, type JobSpec } from '../../compute/types';
import { useComputeStore } from '../../state/compute';
import { useAppStore } from '../../state/app';
import { useChatStore } from '../../state/chat';
import { createId } from '../../lib/utils';

let started = false;
let unsubs: UnlistenFn[] = [];

export async function initializeTauriBridge() {
  if (started) return;
  started = true;

  // If not running inside Tauri, no-op gracefully.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasTauri = typeof (window as any).__TAURI__ !== 'undefined';
  if (!hasTauri) return;

  // Dev-only: enable backend debug logs and mirror key events to DevTools
  if ((import.meta as any)?.env?.DEV) {
    try {
      await invoke('set_debug', { enabled: true });
    } catch {
      // ignore failures enabling debug
    }

    // Mirror backend debug events
    unsubs.push(
      await listen('debug-log', (event) => {
        const payload = event.payload as unknown;
        try {
          const obj = typeof payload === 'string' ? JSON.parse(payload as string) : (payload as Record<string, unknown>);
          const ev = (obj as Record<string, unknown>)?.['event'] ?? 'debug-log';
          // eslint-disable-next-line no-console
          console.debug(`[tauri:${String(ev)}]`, obj);
        } catch {
          // eslint-disable-next-line no-console
          console.debug('[tauri:debug-log]', payload);
        }
      }),
    );

    // Mirror stream chunk sizes without altering aggregator behaviour
    unsubs.push(
      await listen('ollama-completion', (event) => {
        const payload = event.payload as { done?: boolean; delta?: unknown; kind?: string } | undefined;
        if (!payload) return;
        if (payload.done) {
          // eslint-disable-next-line no-console
          console.info('[ollama] done');
        } else if (payload.delta !== undefined) {
          const isStr = typeof payload.delta === 'string';
          const len = isStr ? (payload.delta as string).length : JSON.stringify(payload.delta).length;
          // eslint-disable-next-line no-console
          console.debug(`[ollama:${payload.kind ?? (isStr ? 'text' : 'json')}] len=${len}`);
        }
      }),
    );
  }

  let aggregatorFailed = false;
  const handleAggregatorError = (error: unknown) => {
    if (aggregatorFailed) return;
    aggregatorFailed = true;
    const message = error instanceof Error ? error.message : String(error);
    console.error('ollama aggregator failed', { error: message });
    const appState = useAppStore.getState();
    appState.setStreaming(false);
    appState.pushToast({ variant: 'error', message: `Streaming apply failed: ${message}` });
    useChatStore.getState().pushSystemMessage(`Failed to apply streaming batch: ${message}`, 'ollama_stream_error');
  };

  const aggregator = createOllamaAggregator(async (batch) => {
    const app = useAppStore.getState();
    // If an orchestrator-managed run is in flight, avoid duplicate apply/preview.
    // Orchestrator code will surface plan/act results into chat state and apply as needed.
    if (app.suppressAutoApply) return;

    const canAutoApply = app.fullControl && !app.fullControlLocked;
    if (canAutoApply) {
      const outcome = await enqueueBatch(batch);
      if (!outcome.success) {
        throw new Error(outcome.errors.join('; ') || 'enqueueBatch failed');
      }
      return;
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
  });

  setQueueAppliedListener(({ windowId, applied, ms }) => {
    const tag = windowId && windowId !== '__global__' ? ` • ${windowId}` : '';
    useAppStore.getState().pushToast({ variant: 'success', message: `Applied ${applied} commands in ${Math.round(ms)} ms${tag}` });
  });

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
        (useAppStore.getState() as any).safeMode = true;
        (useAppStore.getState() as any).safeReason = reason;
        useAppStore.setState({} as any);
      } catch (err) {
        console.error('failed to set safe mode', err);
      }
      useAppStore.getState().pushToast({ variant: 'error', message: `Replay issue detected: ${reason}` });
    }),
  );

  unsubs.push(
    await listen('api-key-status', (event) => {
      const payload = event.payload as { valid: boolean; message?: string } | undefined;
      const msg = payload?.message ?? (payload?.valid ? 'API key OK' : 'API key invalid');
      useAppStore.getState().pushToast({ variant: payload?.valid ? 'success' : 'error', message: msg });
    }),
  );

  unsubs.push(
    await listen('ollama-completion', async (event) => {
      const payload = event.payload as { done?: boolean; delta?: unknown } | undefined;
      if (!payload) return;
      if (payload.done) {
        try {
          if (typeof (aggregator as any).flush === 'function') {
            await (aggregator as any).flush();
          }
        } catch (error) {
          handleAggregatorError(error);
        }
        useAppStore.getState().setStreaming(false);
        aggregatorFailed = false;
        return;
      }
      if (payload.delta !== undefined) {
        const text = typeof payload.delta === 'string' ? payload.delta : JSON.stringify(payload.delta);
        try {
          // Reset failure latch when a new stream starts so future runs can surface their own errors.
          if (!useAppStore.getState().streaming) {
            aggregatorFailed = false;
          }
          await aggregator.processDelta(text);
          useAppStore.getState().setStreaming(true);
        } catch (error) {
          handleAggregatorError(error);
        }
      }
    }),
  );

  // Compute plane: debug telemetry for cancellations/timeouts
  unsubs.push(
    await listen('compute.debug', (event) => {
      const payload = event.payload as { jobId?: string; event?: string } | undefined;
      if (!payload) return;
      const jobId = String(payload.jobId ?? '');
      const ev = String(payload.event ?? '');
      if (!jobId) return;
      if (ev === 'cancel_aborted_after_grace') {
        // Mark terminal cancelled so UI does not leak a running job
        useComputeStore.getState().markFinal(jobId, false, undefined, 'Cancelled');
      }
    }),
  );

  // Compute plane: partials + finals
  const pendingBinds = new Map<string, { task: string; binds: { toStatePath: string }[] }>();

  // Expose a helper for callers to submit jobs and remember bindings.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).uicpComputeCall = async (spec: JobSpec) => {
    try {
      pendingBinds.set(spec.jobId, { task: spec.task, binds: spec.bind ?? [] });
      useComputeStore.getState().upsertJob({ jobId: spec.jobId, task: spec.task, status: 'running' });
      await invoke('compute_call', { spec });
    } catch (error) {
      pendingBinds.delete(spec.jobId);
      useComputeStore.getState().markFinal(spec.jobId, false, undefined, 'Compute.CapabilityDenied');
      throw error;
    }
  };

  unsubs.push(
    await listen('compute.result.partial', (event) => {
      const payload = event.payload as { jobId?: string; task?: string; seq?: number; payloadB64?: string } | undefined;
      if (!payload) return;
      // Best-effort dev log; adapter doesn’t apply partials to state yet.
      try {
        const jobId = String(payload.jobId ?? '');
        const task = String(payload.task ?? '');
        const seq = Number(payload.seq ?? 0);
        if (jobId) useComputeStore.getState().markPartial(jobId);
        // eslint-disable-next-line no-console
        console.debug(`[compute.partial] job=${jobId} task=${task} seq=${seq}`);
      } catch {
        // ignore
      }
    }),
  );

  unsubs.push(
    await listen('compute.result.final', async (event) => {
      const payload = event.payload as unknown;
      const parsed = finalEventSchema.safeParse(payload);
      if (!parsed.success) {
        console.error('Invalid compute final payload', parsed.error);
        return;
      }
      const final = parsed.data;
      const entry = pendingBinds.get(final.jobId);
      if (!final.ok) {
        // Surface error feedback; bindings are ignored.
        useAppStore.getState().pushToast({ variant: 'error', message: `${final.task}: ${final.code}` });
        useComputeStore.getState().markFinal(final.jobId, false, undefined, final.code);
        pendingBinds.delete(final.jobId);
        return;
      }
      if (entry && entry.binds && entry.binds.length) {
        // State-only bindings: map each to a workspace-scoped state.set
        const batch = entry.binds.map((b) => ({
          op: 'state.set',
          params: {
            scope: 'workspace',
            key: b.toStatePath,
            value: final.output,
          },
        } as const));
        const outcome = await enqueueBatch(batch);
        if (!outcome.success) {
          console.error('Failed to apply compute bindings', outcome.errors);
          useAppStore.getState().pushToast({ variant: 'error', message: 'Failed to apply compute results' });
        }
      }
      const meta = (final as any).metrics as {
        durationMs?: number;
        fuelUsed?: number;
        memPeakMb?: number;
        cacheHit?: boolean;
        deadlineMs?: number;
        remainingMsAtFinish?: number;
        logCount?: number;
        partialFrames?: number;
        invalidPartialsDropped?: number;
      } | undefined;
      useComputeStore.getState().markFinal(final.jobId, true, {
        durationMs: meta?.durationMs,
        fuelUsed: meta?.fuelUsed,
        memPeakMb: meta?.memPeakMb,
        cacheHit: meta?.cacheHit,
        deadlineMs: meta?.deadlineMs,
        remainingMsAtFinish: meta?.remainingMsAtFinish,
        logCount: meta?.logCount,
        partialFrames: meta?.partialFrames,
        invalidPartialsDropped: meta?.invalidPartialsDropped,
      });
      pendingBinds.delete(final.jobId);
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

  window.addEventListener('uicp-intent', onIntent, false);
  unsubs.push(() => window.removeEventListener('uicp-intent', onIntent, false));
}

export function teardownTauriBridge() {
  for (const off of unsubs) {
    try {
      off();
    } catch {
      // ignore
    }
  }
  unsubs = [];
  started = false;
}
