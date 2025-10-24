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
    try { fn(runtimePolicy); } catch {}
  }
}

function fromEnv(): Policy {
  const env: any = (import.meta as any)?.env ?? {};
  const safe = String(env.UICP_SAFE_MODE ?? '0').toLowerCase();
  if (safe === '1' || safe === 'true') return Presets.locked;
  const raw = String(env.UICP_POLICY ?? '').trim();
  if (!raw) return Presets.balanced;
  const lower = raw.toLowerCase();
  if (lower === 'open') return Presets.open;
  if (lower === 'balanced') return Presets.balanced;
  if (lower === 'locked' || lower === 'locked_down' || lower === 'locked-down') return Presets.locked;
  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw);
      return ensurePolicy(obj);
    } catch {
      return Presets.balanced;
    }
  }
  // Path-based loading is not implemented in the browser context; fall back.
  return Presets.balanced;
}

export function getEffectivePolicy(): Policy {
  return runtimePolicy ?? fromEnv();
}
