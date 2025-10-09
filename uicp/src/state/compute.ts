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
      return { jobs: { ...state.jobs, [job.jobId]: next } };
    }),
  markPartial: (jobId) =>
    set((state) => {
      const existing = state.jobs[jobId];
      if (!existing) return { jobs: state.jobs };
      const next = { ...existing, status: 'partial' as const, partials: existing.partials + 1, updatedAt: Date.now() };
      return { jobs: { ...state.jobs, [jobId]: next } };
    }),
  markFinal: (jobId, ok, meta, errMsg) =>
    set((state) => {
      const existing = state.jobs[jobId];
      if (!existing) return { jobs: state.jobs };
      const status: ComputeStatus = ok ? 'done' : errMsg === 'Compute.Cancelled' ? 'cancelled' : errMsg === 'Compute.Timeout' ? 'timeout' : 'error';
      const next = { ...existing, status, updatedAt: Date.now(), ...meta, lastError: ok ? undefined : errMsg };
      return { jobs: { ...state.jobs, [jobId]: next } };
    }),
  reset: () => set({ jobs: {} }),
}));
