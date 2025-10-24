/// <reference lib="dom" />
/* global EventListener */
import { installNetworkGuard } from './networkGuard';
import { emitTelemetryEvent } from '../telemetry';
import type { TelemetryEventName } from '../telemetry/types';
import { useAppStore } from '../../state/app';

export type RolloutStage = 'monitor' | 'enforce' | 'auto';

export type GuardRolloutOptions = {
  stage?: RolloutStage;
  minutesMonitor?: number;
  storageKey?: string;
  onEscalate?: () => void;
};

export type GuardRolloutState = {
  startedAt: number;
  blockCount: number;
  attemptCount: number;
  lastEscalatedAt?: number;
  stage: RolloutStage;
};

const now = () => Date.now();
const MINUTES = (m: number) => m * 60 * 1000;

const getEnvStage = (): RolloutStage => {
  const env = ((import.meta as unknown) as { env?: Record<string, unknown> }).env ?? {};
  const val = String(env.VITE_GUARD_ROLLOUT_STAGE ?? '').toLowerCase();
  if (val === 'monitor' || val === 'enforce' || val === 'auto') return val as RolloutStage;
  // Default: auto in dev, enforce in prod
  const mode = String((env as Record<string, unknown>).MODE ?? (env as Record<string, unknown>).NODE_ENV ?? '').toLowerCase();
  return mode === 'development' || mode === 'dev' ? 'auto' : 'enforce';
};

const getEnvMinutes = (): number => {
  const env = ((import.meta as unknown) as { env?: Record<string, unknown> }).env ?? {};
  const num = Number(env.VITE_GUARD_ROLLOUT_MINUTES_MONITOR);
  if (Number.isFinite(num) && num > 0) return num;
  return 30; // default 30 min
};

const getEnvFprThreshold = (): number => {
  const env = ((import.meta as unknown) as { env?: Record<string, unknown> }).env ?? {};
  const n = Number(env.VITE_GUARD_FPR_THRESHOLD);
  if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  return 0.001; // 0.1%
};

const getEnvMinAttempts = (): number => {
  const env = ((import.meta as unknown) as { env?: Record<string, unknown> }).env ?? {};
  const n = Number(env.VITE_GUARD_MIN_ATTEMPTS);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return 50;
};

const STORAGE_KEY_DEFAULT = 'uicp:netguard:rollout';

const readState = (key: string): GuardRolloutState | null => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return null;
    return obj as GuardRolloutState;
  } catch {
    return null;
  }
};

const writeState = (key: string, state: GuardRolloutState) => {
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch (err) {
    // keep rollout non-fatal
     
    console.warn('[rollout] failed to write state', err);
  }
};

const getTraceId = (): string => {
  try {
    const s = useAppStore.getState();
    const tid = s.agentStatus.traceId || 'net-guard';
    return String(tid || 'net-guard');
  } catch {
    return 'net-guard';
  }
};

const emit = (name: TelemetryEventName, data: Record<string, unknown>) => {
  try {
    emitTelemetryEvent(name, { traceId: getTraceId(), data });
  } catch (err) {
    // keep guard non-fatal
     
    console.warn('[rollout] failed to emit telemetry', err);
  }
};

export const startGuardRollout = (opts?: GuardRolloutOptions) => {
  const stage: RolloutStage = opts?.stage ?? getEnvStage();
  const minutesMonitor = opts?.minutesMonitor ?? getEnvMinutes();
  const fprThreshold = getEnvFprThreshold();
  const minAttempts = getEnvMinAttempts();
  const storageKey = opts?.storageKey ?? STORAGE_KEY_DEFAULT;

  let state = readState(storageKey) ?? {
    startedAt: now(),
    blockCount: 0,
    attemptCount: 0,
    stage,
  };

  // Persist initial
  writeState(storageKey, state);

  const onBlock = (e: CustomEvent) => {
    state.blockCount += 1;
    writeState(storageKey, state);
    const detail = (e as CustomEvent<{ reason?: string; api?: string }>).detail;
    const reason = detail?.reason;
    const api = detail?.api;
    emit('security.net_guard.block', { reason, api, blocks: state.blockCount });
  };

  const onAttempt = () => {
    state.attemptCount += 1;
    writeState(storageKey, state);
  };

  try {
    window.addEventListener('net-guard-block', onBlock as EventListener);
    window.addEventListener('net-guard-attempt', onAttempt as EventListener);
  } catch (err) {
    console.warn('[rollout] failed to attach listeners', err);
  }

  const checkEscalate = () => {
    if (state.stage === 'enforce') return;
    if (stage === 'monitor') return; // fixed stage
    if (stage === 'enforce') return; // fixed stage

    const elapsed = now() - state.startedAt;
    const ready = elapsed >= MINUTES(minutesMonitor);
    if (!ready) return;
    const attempts = Math.max(0, state.attemptCount);
    const blocks = Math.max(0, state.blockCount);
    // If no attempts observed, allow zero-block fast path
    if (attempts === 0 && blocks === 0) {
      try {
        if (opts?.onEscalate) {
          opts.onEscalate();
        } else {
          installNetworkGuard({ monitorOnly: false });
        }
        state.stage = 'enforce';
        state.lastEscalatedAt = now();
        writeState(storageKey, state);
        emit('security.net_guard.rollout_state', { from: 'monitor', to: 'enforce', minutesMonitor, method: 'zero_attempts' });
      } catch (err) {
        console.error('[rollout] failed to escalate guard', err);
      }
      return;
    }
    if (attempts < minAttempts) return;
    const fpr = attempts > 0 ? blocks / attempts : 0;
    if (fpr > fprThreshold) return;

    // Escalate to enforce
    try {
      if (opts?.onEscalate) {
        opts.onEscalate();
      } else {
        installNetworkGuard({ monitorOnly: false });
      }
      state.stage = 'enforce';
      state.lastEscalatedAt = now();
      writeState(storageKey, state);
      emit('security.net_guard.rollout_state', { from: 'monitor', to: 'enforce', minutesMonitor, method: 'fpr', fpr, attempts, blocks, threshold: fprThreshold });
    } catch (err) {
      console.error('[rollout] failed to escalate guard', err);
    }
  };

  const interval = window.setInterval(checkEscalate, 15_000);

  // Expose a tiny controller for tests/devtools
  return {
    getState: () => ({ ...state }),
    checkNow: () => checkEscalate(),
    stop: () => {
      try { window.removeEventListener('net-guard-block', onBlock as EventListener); } catch (err) {
        console.warn('[rollout] failed to remove block listener', err);
      }
      try { window.removeEventListener('net-guard-attempt', onAttempt as EventListener); } catch (err) {
        console.warn('[rollout] failed to remove attempt listener', err);
      }
      window.clearInterval(interval);
    },
  };
};
