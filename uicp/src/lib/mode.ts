// WHY: Centralize config into four default modes and ensure
// INVARIANT: Only 4 default configurations exist without overrides.
// ERROR: E-UICP-1001 invalid UICP mode
export type AppMode = 'dev' | 'test' | 'pilot' | 'prod';

function readEnv(name: string): string | undefined {
  // Vite exposes import.meta.env; Node scripts/tests can use process.env
  try {
    if (typeof import.meta !== 'undefined') {
      const meta = import.meta as unknown;
      if (typeof meta === 'object' && meta !== null) {
        const envRecord = (meta as { env?: Record<string, unknown> }).env;
        const raw = envRecord?.[name];
        if (typeof raw === 'string') {
          return raw;
        }
      }
    }
  } catch {
    // ignore import.meta access errors
  }
  try {
    if (typeof process !== 'undefined' && typeof process.env === 'object' && process.env !== null) {
      const raw = process.env[name];
      return typeof raw === 'string' ? raw : undefined;
    }
  } catch {
    // ignore process access errors
  }
  return undefined;
}

export function getAppMode(): AppMode {
  const explicit = (readEnv('VITE_UICP_MODE') || readEnv('UICP_MODE') || '').toLowerCase().trim();
  if (explicit === 'dev' || explicit === 'test' || explicit === 'pilot' || explicit === 'prod') {
    return explicit;
  }

  // Derive from Vite mode when not explicitly set
  const viteMode = (readEnv('MODE') || '').toLowerCase();
  const viteDev = (readEnv('DEV') || '').toLowerCase();
  if (viteMode === 'test') return 'test';
  if (viteDev === 'true') return 'dev';
  return 'prod';
}

export type ModeDefaults = {
  devMode: boolean;
  plannerTwoPhase: boolean;
  wilOnly: boolean;
  wilDebug: boolean;
  plannerTimeoutMs: number;
  actorTimeoutMs: number;
};

export function getModeDefaults(mode: AppMode = getAppMode()): ModeDefaults {
  switch (mode) {
    case 'dev':
      return {
        devMode: true,
        plannerTwoPhase: true,
        wilOnly: false,
        wilDebug: true,
        plannerTimeoutMs: 180_000,
        actorTimeoutMs: 180_000,
      };
    case 'test':
      return {
        devMode: false,
        // Keep existing behavior: two-phase off during tests
        plannerTwoPhase: false,
        wilOnly: false,
        wilDebug: false,
        // Keep generous timeouts to avoid flakes; callers can override
        plannerTimeoutMs: 180_000,
        actorTimeoutMs: 180_000,
      };
    case 'pilot':
      return {
        devMode: false,
        // JSON-first production pilot uses two-phase planner by default
        plannerTwoPhase: true,
        wilOnly: false,
        wilDebug: false,
        plannerTimeoutMs: 180_000,
        actorTimeoutMs: 180_000,
      };
    case 'prod':
    default:
      return {
        devMode: false,
        plannerTwoPhase: true,
        wilOnly: false,
        wilDebug: false,
        plannerTimeoutMs: 180_000,
        actorTimeoutMs: 180_000,
      };
  }
}
