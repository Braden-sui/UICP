import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { createOllamaAggregator } from '../uicp/stream';
import { enqueueBatch, setQueueAppliedListener } from '../uicp/queue';
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

  const aggregator = createOllamaAggregator(async (batch) => {
    const app = useAppStore.getState();
    // If an orchestrator-managed run is in flight, avoid duplicate apply/preview.
    // Orchestrator code will surface plan/act results into chat state and apply as needed.
    if (app.suppressAutoApply) return;

    const canAutoApply = app.fullControl && !app.fullControlLocked;
    if (canAutoApply) {
      await enqueueBatch(batch);
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
      const payload = event.payload as { done?: boolean; delta?: unknown } | undefined;
      if (!payload) return;
      if (payload.done) {
        await aggregator.flush();
        useAppStore.getState().setStreaming(false);
        return;
      }
      if (payload.delta !== undefined) {
        const text = typeof payload.delta === 'string' ? payload.delta : JSON.stringify(payload.delta);
        await aggregator.processDelta(text);
        useAppStore.getState().setStreaming(true);
      }
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
