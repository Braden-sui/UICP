import { create } from 'zustand';

export type ComputeStatus = 'queued' | 'running' | 'partial' | 'done' | 'error' | 'cancelled' | 'timeout';

export type ComputeJob = {
  jobId: string;
  task: string;
  status: ComputeStatus;
  partials: number;
  cacheHit?: boolean;
  durationMs?: number;
  memPeakMb?: number;
  fuelUsed?: number;
  deadlineMs?: number;
  remainingMsAtFinish?: number;
  logCount?: number;
  partialFrames?: number;
  invalidPartialsDropped?: number;
  lastError?: string;
  updatedAt: number;
};

type ComputeState = {
  jobs: Record<string, ComputeJob>;
  upsertJob: (job: Pick<ComputeJob, 'jobId' | 'task'> & Partial<ComputeJob>) => void;
  markPartial: (jobId: string) => void;
  markFinal: (jobId: string, ok: boolean, meta?: Partial<ComputeJob>, errMsg?: string) => void;
  reset: () => void;
};

// LRU policy for terminal jobs
const MAX_TERMINAL_JOBS = 100;

function pruneJobs(jobs: Record<string, ComputeJob>, maxTerminal = MAX_TERMINAL_JOBS): Record<string, ComputeJob> {
  const list = Object.values(jobs);
  const active = list.filter((j) => j.status === 'running' || j.status === 'partial');
  const terminal = list
    .filter((j) => j.status !== 'running' && j.status !== 'partial')
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const budget = Math.max(0, maxTerminal - active.length);
  const keep = [...active, ...terminal.slice(0, budget)];
  const next: Record<string, ComputeJob> = {};
  for (const j of keep) next[j.jobId] = jobs[j.jobId];
  return next;
}

export const useComputeStore = create<ComputeState>((set) => ({
  jobs: {},
  upsertJob: (job) =>
    set((state) => {
      const existing = state.jobs[job.jobId];
      const now = Date.now();
      const next: ComputeJob = existing
        ? { ...existing, ...job, updatedAt: now }
        : {
            jobId: job.jobId,
            task: job.task,
            status: job.status ?? 'running',
            partials: 0,
            updatedAt: now,
            cacheHit: job.cacheHit,
            durationMs: job.durationMs,
            memPeakMb: job.memPeakMb,
            fuelUsed: job.fuelUsed,
            lastError: job.lastError,
          };
      const merged = { ...state.jobs, [job.jobId]: next } as Record<string, ComputeJob>;
      const pruned = pruneJobs(merged);
      return { jobs: pruned };
    }),
  markPartial: (jobId) =>
    set((state) => {
      const existing = state.jobs[jobId];
      if (!existing) return { jobs: state.jobs };
      const next = { ...existing, status: 'partial' as const, partials: existing.partials + 1, updatedAt: Date.now() };
      const merged = { ...state.jobs, [jobId]: next } as Record<string, ComputeJob>;
      const pruned = pruneJobs(merged);
      return { jobs: pruned };
    }),
  markFinal: (jobId, ok, meta, errMsg) =>
    set((state) => {
      const existing = state.jobs[jobId];
      if (!existing) return { jobs: state.jobs };
      // Normalize backend codes (e.g., "Timeout", "Cancelled") and also support legacy "Compute.*" prefixes.
      const normalized = String(errMsg ?? '')?.replace(/^Compute\./, '');
      const status: ComputeStatus = ok
        ? 'done'
        : normalized === 'Cancelled'
          ? 'cancelled'
          : normalized === 'Timeout'
            ? 'timeout'
            : 'error';
      const next = { ...existing, status, updatedAt: Date.now(), ...meta, lastError: ok ? undefined : errMsg };
      const merged = { ...state.jobs, [jobId]: next } as Record<string, ComputeJob>;
      const pruned = pruneJobs(merged);
      return { jobs: pruned };
    }),
  reset: () => set({ jobs: {} }),
}));
