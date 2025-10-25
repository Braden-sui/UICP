import { ensurePolicy, type Policy } from './policy';
import { Presets } from './presets';

let runtimePolicy: Policy | null = null;

type Listener = (p: Policy) => void;
const listeners = new Set<Listener>();

export function onPolicyChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setRuntimePolicy(p: Partial<Policy>) {
  runtimePolicy = ensurePolicy(p as Policy);
  for (const fn of Array.from(listeners)) {
    try { fn(runtimePolicy); } catch (err) {
      // keep non-fatal: policy listeners must not crash app
      console.warn('[policyLoader] listener failed', err);
    }
  }
}

const extractEnv = (source: unknown): Record<string, unknown> => {
  if (!source || typeof source !== 'object') return {};
  const envCandidate = (source as { env?: unknown }).env;
  if (envCandidate && typeof envCandidate === 'object') {
    return envCandidate as Record<string, unknown>;
  }
  return {};
};

function fromEnv(): Policy {
  const metaEnv = extractEnv(typeof import.meta !== 'undefined' ? import.meta : undefined);
  const procEnv = extractEnv(typeof process !== 'undefined' ? process : undefined);
  const env = { ...metaEnv, ...procEnv } as Record<string, unknown>;
  const safe = String(env.UICP_SAFE_MODE ?? '0').toLowerCase();
  if (safe === '1' || safe === 'true') return Presets.locked;
  const raw = String(env.UICP_POLICY ?? '').trim();
  if (!raw) return Presets.open;
  const lower = raw.toLowerCase();
  if (lower === 'open') return Presets.open;
  if (lower === 'balanced') return Presets.balanced;
  if (lower === 'locked' || lower === 'locked_down' || lower === 'locked-down') return Presets.locked;
  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw);
      return ensurePolicy(obj);
    } catch (err) {
      console.warn('[policyLoader] failed to parse UICP_POLICY JSON, falling back to open', err);
      return Presets.open;
    }
  }
  // Path-based loading is not implemented in the browser context; fall back.
  return Presets.open;
}

export function getEffectivePolicy(): Policy {
  return runtimePolicy ?? fromEnv();
}
