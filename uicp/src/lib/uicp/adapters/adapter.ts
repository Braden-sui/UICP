export {
  registerWindowLifecycle,
  registerWorkspaceRoot,
  registerUIEventCallback,
  deferBatchIfNotReady,
  resetWorkspace,
  replayWorkspace,
  listWorkspaceWindows,
  closeWorkspaceWindow,
} from "./adapter.lifecycle";

export { applyBatch } from "./adapter.queue";
export type { ApplyOutcome, ApplyOptions } from "./schemas";

export { buildComponentMarkupForTest } from "./adapter.testkit";
