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
  queueWaitMs?: number;
  logCount?: number;
  emittedLogBytes?: number;
  partialFrames?: number;
  invalidPartialsDropped?: number;
  logThrottleWaits?: number;
  loggerThrottleWaits?: number;
  partialThrottleWaits?: number;
  goldenHash?: string;
  goldenMatched?: boolean;
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

const markComputeStore = (event: string) => {
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    performance.mark(event);
  }
};

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
      markComputeStore('compute-store-upsert');
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
      markComputeStore('compute-store-queued');
      const existing = state.jobs[jobId];
      if (!existing || existing.status === 'queued') return { jobs: state.jobs };
      const next = { ...existing, status: 'queued' as const, updatedAt: Date.now() };
      const merged = { ...state.jobs, [jobId]: next } as Record<string, ComputeJob>;
      const pruned = pruneJobs(merged);
      return { jobs: pruned };
    }),
  markRunning: (jobId) =>
    set((state) => {
      markComputeStore('compute-store-running');
      const existing = state.jobs[jobId];
      if (!existing || existing.status === 'running') return { jobs: state.jobs };
      const next = { ...existing, status: 'running' as const, updatedAt: Date.now() };
      const merged = { ...state.jobs, [jobId]: next } as Record<string, ComputeJob>;
      const pruned = pruneJobs(merged);
      return { jobs: pruned };
    }),
  markPartial: (jobId) =>
    set((state) => {
      markComputeStore('compute-store-partial');
      const existing = state.jobs[jobId];
      if (!existing) return { jobs: state.jobs };
      const next = { ...existing, status: 'partial' as const, partials: existing.partials + 1, updatedAt: Date.now() };
      const merged = { ...state.jobs, [jobId]: next } as Record<string, ComputeJob>;
      const pruned = pruneJobs(merged);
      return { jobs: pruned };
    }),
  markFinal: (jobId, ok, meta, errMsg, errCode) =>
    set((state) => {
      markComputeStore('compute-store-final');
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
      markComputeStore('compute-store-remove');
      if (!state.jobs[jobId]) return { jobs: state.jobs };
      const next = { ...state.jobs };
      delete next[jobId];
      return { jobs: next };
  }),
  reset: () => {
    markComputeStore('compute-store-reset');
    set({ jobs: {} });
  },
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
  goldenVerified: number;
  goldenMismatched: number;
  determinismRatio: number; // verified / (verified + mismatched)
  backpressureWaits: number; // sum of all throttle waits
  recent: ComputeJob[];
};

const percentile = (values: number[], p: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
};

let lastJobsSnapshot: Record<string, ComputeJob> | null = null;
let lastRecentLimit = 0;
let lastSummary: ComputeSummary | null = null;

export const summarizeComputeJobs = (
  jobs: Record<string, ComputeJob>,
  recentLimit = 8,
): ComputeSummary => {
  if (jobs === lastJobsSnapshot && lastSummary && recentLimit === lastRecentLimit) {
    return lastSummary;
  }

  const list = Object.values(jobs);
  let queued = 0;
  let running = 0;
  let partial = 0;
  let done = 0;
  let cancelled = 0;
  let timeout = 0;
  let error = 0;
  let cacheHits = 0;
  let doneWithCache = 0;
  let partialsSeen = 0;
  let partialFrames = 0;
  let invalidPartialsDropped = 0;
  let logCount = 0;
  let emittedLogBytes = 0;
  let logThrottleWaits = 0;
  let loggerThrottleWaits = 0;
  let partialThrottleWaits = 0;
  let fuelUsed = 0;
  let active = 0;
  let goldenVerified = 0;
  let goldenMismatched = 0;

  const durations: number[] = [];
  const memPeaks: number[] = [];
  const recentCandidates: ComputeJob[] = [];

  for (const job of list) {
    switch (job.status) {
      case 'queued':
        queued += 1;
        active += 1;
        break;
      case 'running':
        running += 1;
        active += 1;
        break;
      case 'partial':
        partial += 1;
        active += 1;
        break;
      case 'done':
        done += 1;
        break;
      case 'cancelled':
        cancelled += 1;
        break;
      case 'timeout':
        timeout += 1;
        break;
      case 'error':
        error += 1;
        break;
      default:
        break;
    }

    if (job.cacheHit) {
      cacheHits += 1;
      if (job.status === 'done') {
        doneWithCache += 1;
      }
    }

    partialsSeen += job.partials ?? 0;
    partialFrames += job.partialFrames ?? 0;
    invalidPartialsDropped += job.invalidPartialsDropped ?? 0;
    logCount += job.logCount ?? 0;
    emittedLogBytes += job.emittedLogBytes ?? 0;
    logThrottleWaits += job.logThrottleWaits ?? 0;
    loggerThrottleWaits += job.loggerThrottleWaits ?? 0;
    partialThrottleWaits += job.partialThrottleWaits ?? 0;
    fuelUsed += job.fuelUsed ?? 0;

    if (typeof job.goldenMatched === 'boolean') {
      if (job.goldenMatched) goldenVerified += 1;
      else goldenMismatched += 1;
    }

    const duration = job.durationMs ?? 0;
    if (duration > 0) {
      durations.push(duration);
    }
    const memPeak = job.memPeakMb ?? 0;
    if (memPeak > 0) {
      memPeaks.push(memPeak);
    }

    recentCandidates.push(job);
  }

  const durationP50 = percentile(durations, 0.5);
  const durationP95 = percentile(durations, 0.95);
  const memPeakP95 = percentile(memPeaks, 0.95);
  const cacheRatio = done > 0 ? Math.round((doneWithCache / done) * 100) : 0;
  const determinismDenom = goldenVerified + goldenMismatched;
  const determinismRatio = determinismDenom > 0 ? Math.round((goldenVerified / determinismDenom) * 100) : 0;
  const backpressureWaits = logThrottleWaits + loggerThrottleWaits + partialThrottleWaits;
  const recent = recentCandidates
    .filter((job) => job != null)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, recentLimit);

  lastJobsSnapshot = jobs;
  lastRecentLimit = recentLimit;
  lastSummary = {
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
    goldenVerified,
    goldenMismatched,
    determinismRatio,
    backpressureWaits,
    durationP50: durationP50 ?? null,
    durationP95: durationP95 ?? null,
    memPeakP95: memPeakP95 ?? null,
    recent,
  };

  return lastSummary;
};
