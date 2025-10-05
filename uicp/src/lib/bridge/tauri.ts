import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { createOllamaAggregator } from '../uicp/stream';
import { setQueueAppliedListener } from '../uicp/queue';
import { useAppStore } from '../../state/app';

let started = false;
let unsubs: UnlistenFn[] = [];

export async function initializeTauriBridge() {
  if (started) return;
  started = true;

  // If not running inside Tauri, no-op gracefully.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasTauri = typeof (window as any).__TAURI__ !== 'undefined';
  if (!hasTauri) return;

  const aggregator = createOllamaAggregator();

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
