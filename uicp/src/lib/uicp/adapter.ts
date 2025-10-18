// Re-export from adapters folder for backward compatibility
export {
  registerWindowLifecycle,
  registerWorkspaceRoot,
  registerUIEventCallback,
  deferBatchIfNotReady,
  resetWorkspace,
  replayWorkspace,
  listWorkspaceWindows,
  closeWorkspaceWindow,
} from "./adapters/adapter.lifecycle";

// Keep exports aligned with adapters/adapter.ts
export { applyBatch } from "./adapters/adapter.queue";
export type { ApplyOutcome, ApplyOptions } from "./adapters/schemas";

export { buildComponentMarkupForTest } from "./adapters/adapter.testkit";
