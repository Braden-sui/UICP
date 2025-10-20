import type { ApplyOutcome, Batch } from "./schemas";
import { enqueueBatch } from "./queue";

// WHY: Lifecycle needs to enqueue batches without creating an eager circular import.
// This proxy module is only loaded on demand so evaluation happens after lifecycle initializes.
export const enqueueScriptBatch = async (batch: Batch): Promise<ApplyOutcome> => {
  return await enqueueBatch(batch);
};
