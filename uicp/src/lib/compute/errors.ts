// Shared compute error taxonomy for UI and bridges.
// Keep codes exactly matching Rust constants in src-tauri/src/compute.rs.

export const ComputeError = {
  Timeout: 'Timeout',
  Cancelled: 'Cancelled',
  CapabilityDenied: 'Compute.CapabilityDenied',
  ResourceLimit: 'Compute.Resource.Limit',
  RuntimeFault: 'Runtime.Fault',
  IODenied: 'IO.Denied',
  TaskNotFound: 'Task.NotFound',
  Nondeterministic: 'Nondeterministic',
} as const;

export type ComputeErrorCode = typeof ComputeError[keyof typeof ComputeError];
