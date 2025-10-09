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
  markQueued: (jobId: string) => void;
  markRunning: (jobId: string) => void;
  removeJob: (jobId: string) => void;
  markFinal: (jobId: string, ok: boolean, meta?: Partial<ComputeJob>, errMsg?: string, errCode?: string) => void;
  reset: () => void;
};

// Retain all active jobs plus up to this many terminal jobs (newest first).
const MAX_TERMINAL_JOBS = 100;

function pruneJobs(jobs: Record<string, ComputeJob>, maxTerminal = MAX_TERMINAL_JOBS): Record<string, ComputeJob> {
  const list = Object.values(jobs);
  const active = list.filter((j) => j.status === 'running' || j.status === 'partial' || j.status === 'queued');
  const terminal = list
    .filter((j) => j.status !== 'running' && j.status !== 'partial' && j.status !== 'queued')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, maxTerminal);
  const keep = [...active, ...terminal];
  const next: Record<string, ComputeJob> = {};
  for (const j of keep) next[j.jobId] = jobs[j.jobId];
  if (Object.keys(next).length === Object.keys(jobs).length) {
    return jobs;
  }
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
            ...job,
            jobId: job.jobId,
            task: job.task,
            status: job.status ?? 'running',
            partials: job.partials ?? 0,
            updatedAt: now,
          } as ComputeJob;
      const merged = { ...state.jobs, [job.jobId]: next } as Record<string, ComputeJob>;
      const pruned = pruneJobs(merged);
      return { jobs: pruned };
    }),
  markQueued: (jobId) =>
    set((state) => {
      const existing = state.jobs[jobId];
      if (!existing || existing.status === 'queued') return { jobs: state.jobs };
      const next = { ...existing, status: 'queued' as const, updatedAt: Date.now() };
      const merged = { ...state.jobs, [jobId]: next } as Record<string, ComputeJob>;
      const pruned = pruneJobs(merged);
      return { jobs: pruned };
    }),
  markRunning: (jobId) =>
    set((state) => {
      const existing = state.jobs[jobId];
      if (!existing || existing.status === 'running') return { jobs: state.jobs };
      const next = { ...existing, status: 'running' as const, updatedAt: Date.now() };
      const merged = { ...state.jobs, [jobId]: next } as Record<string, ComputeJob>;
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
  markFinal: (jobId, ok, meta, errMsg, errCode) =>
    set((state) => {
      const existing = state.jobs[jobId];
      if (!existing) return { jobs: state.jobs };
      const normalizedSource = errCode ?? errMsg ?? '';
      const normalized = String(normalizedSource).replace(/^Compute\./, '');
      const status: ComputeStatus =
        meta?.status ??
        (ok
          ? 'done'
          : /^cancelled/i.test(normalized)
            ? 'cancelled'
            : /^timeout/i.test(normalized)
              ? 'timeout'
              : 'error');
      const errorText = errMsg ?? errCode ?? (normalized ? normalized : undefined);
      const next = {
        ...existing,
        ...meta,
        status,
        updatedAt: Date.now(),
        lastError: ok ? undefined : errorText,
      };
      const merged = { ...state.jobs, [jobId]: next } as Record<string, ComputeJob>;
      const pruned = pruneJobs(merged);
      return { jobs: pruned };
    }),
  removeJob: (jobId) =>
    set((state) => {
      if (!state.jobs[jobId]) return { jobs: state.jobs };
      const next = { ...state.jobs };
      delete next[jobId];
      return { jobs: next };
    }),
  reset: () => set({ jobs: {} }),
}));
