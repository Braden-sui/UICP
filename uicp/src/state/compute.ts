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
  emittedLogBytes?: number;
  partialFrames?: number;
  invalidPartialsDropped?: number;
  logThrottleWaits?: number;
  loggerThrottleWaits?: number;
  partialThrottleWaits?: number;
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

const ACTIVE_STATES: ComputeStatus[] = ['running', 'partial', 'queued'];

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

export type ComputeSummary = {
  total: number;
  queued: number;
  running: number;
  partial: number;
  active: number;
  done: number;
  cancelled: number;
  timeout: number;
  error: number;
  cacheHits: number;
  cacheRatio: number;
  partialsSeen: number;
  partialFrames: number;
  invalidPartialsDropped: number;
  logCount: number;
  logThrottleWaits: number;
  loggerThrottleWaits: number;
  partialThrottleWaits: number;
  emittedLogBytes: number;
  fuelUsed: number;
  durationP50: number | null;
  durationP95: number | null;
  memPeakP95: number | null;
  recent: ComputeJob[];
};

const percentile = (values: number[], p: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
};

export const summarizeComputeJobs = (
  jobs: Record<string, ComputeJob>,
  recentLimit = 8,
): ComputeSummary => {
  const list = Object.values(jobs);
  const queued = list.filter((j) => j.status === 'queued').length;
  const running = list.filter((j) => j.status === 'running').length;
  const partial = list.filter((j) => j.status === 'partial').length;
  const done = list.filter((j) => j.status === 'done').length;
  const cancelled = list.filter((j) => j.status === 'cancelled').length;
  const timeout = list.filter((j) => j.status === 'timeout').length;
  const error = list.filter((j) => j.status === 'error').length;
  const cacheHits = list.filter((j) => j.cacheHit === true).length;
  const doneWithCache = list.filter((j) => j.status === 'done' && j.cacheHit === true).length;
  const cacheRatio =
    done > 0 ? Math.round((doneWithCache / done) * 100) : 0;
  const partialsSeen = list.reduce((acc, job) => acc + (job.partials ?? 0), 0);
  const partialFrames = list.reduce((acc, job) => acc + (job.partialFrames ?? 0), 0);
  const invalidPartialsDropped = list.reduce(
    (acc, job) => acc + (job.invalidPartialsDropped ?? 0),
    0,
  );
  const logCount = list.reduce((acc, job) => acc + (job.logCount ?? 0), 0);
  const emittedLogBytes = list.reduce((acc, job) => acc + (job.emittedLogBytes ?? 0), 0);
  const logThrottleWaits = list.reduce((acc, job) => acc + (job.logThrottleWaits ?? 0), 0);
  const loggerThrottleWaits = list.reduce((acc, job) => acc + (job.loggerThrottleWaits ?? 0), 0);
  const partialThrottleWaits = list.reduce((acc, job) => acc + (job.partialThrottleWaits ?? 0), 0);
  const fuelUsed = list.reduce((acc, job) => acc + (job.fuelUsed ?? 0), 0);
  const durations = list
    .map((job) => job.durationMs ?? 0)
    .filter((n) => n > 0);
  const memPeaks = list
    .map((job) => job.memPeakMb ?? 0)
    .filter((n) => n > 0);
  const durationP50 = percentile(durations, 0.5);
  const durationP95 = percentile(durations, 0.95);
  const memPeakP95 = percentile(memPeaks, 0.95);
  const recent = [...list]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, recentLimit);
  const active = list.filter((j) => ACTIVE_STATES.includes(j.status)).length;
  return {
    total: list.length,
    queued,
    running,
    partial,
    active,
    done,
    cancelled,
    timeout,
    error,
    cacheHits,
    cacheRatio,
    partialsSeen,
    partialFrames,
    invalidPartialsDropped,
    logCount,
    emittedLogBytes,
    logThrottleWaits,
    loggerThrottleWaits,
    partialThrottleWaits,
    fuelUsed,
    durationP50: durationP50 ?? null,
    durationP95: durationP95 ?? null,
    memPeakP95: memPeakP95 ?? null,
    recent,
  };
};
