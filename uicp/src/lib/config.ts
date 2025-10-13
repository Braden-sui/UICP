import { readBooleanEnv, readNumberEnv } from './env/values';

export const cfg = {
  // Planner/Actor caps
  followupMaxDefault: readNumberEnv('FOLLOWUP_MAX_DEFAULT', 3, { min: 1 }),
  followupMaxHard: readNumberEnv('FOLLOWUP_MAX_HARD', 5, { min: 1 }),
  actorBatchDefault: readNumberEnv('ACTOR_BATCH_DEFAULT', 50, { min: 1 }),
  actorBatchHard: readNumberEnv('ACTOR_BATCH_HARD', 200, { min: 1 }),
  appWallclockMs: readNumberEnv('APP_WALLCLOCK_MS', 5000, { min: 1 }),
  appMemMb: readNumberEnv('APP_MEM_MB', 128, { min: 1 }),
  // Feature toggles (default WIL-only ON)
  wilOnly: readBooleanEnv('VITE_WIL_ONLY', true),
  wilDebug: readBooleanEnv('VITE_WIL_DEBUG', false),
  wilMaxBufferKb: readNumberEnv('VITE_WIL_MAX_BUFFER_KB', 256, { min: 1 }),
};
