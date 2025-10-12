function readNum(key: string, fallback: number): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (import.meta as any)?.env?.[key] as unknown;
    const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : undefined;
    return Number.isFinite(n) && (n as number) > 0 ? (n as number) : fallback;
  } catch {
    return fallback;
  }
}

function readFlag(key: string, fallback = false): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = String((import.meta as any)?.env?.[key] ?? (fallback ? '1' : '0'));
    return raw === '1' || raw.toLowerCase() === 'true';
  } catch {
    return fallback;
  }
}

export const cfg = {
  // Planner/Actor caps
  followupMaxDefault: readNum('FOLLOWUP_MAX_DEFAULT', 3),
  followupMaxHard: readNum('FOLLOWUP_MAX_HARD', 5),
  actorBatchDefault: readNum('ACTOR_BATCH_DEFAULT', 50),
  actorBatchHard: readNum('ACTOR_BATCH_HARD', 200),
  appWallclockMs: readNum('APP_WALLCLOCK_MS', 5000),
  appMemMb: readNum('APP_MEM_MB', 128),
  // Feature toggles (default WIL-only ON)
  wilOnly: readFlag('VITE_WIL_ONLY', true),
  wilDebug: readFlag('VITE_WIL_DEBUG', false),
  wilMaxBufferKb: readNum('VITE_WIL_MAX_BUFFER_KB', 256),
};
