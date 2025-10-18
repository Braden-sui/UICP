import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Batch } from '../adapters/schemas';
import { computeBatchHash } from '../adapters/schemas';

// Mock stream.ts to avoid import resolution issues during test
vi.mock('../stream', () => ({
  default: vi.fn(),
}));

import { applyBatch, resetWorkspace, registerWorkspaceRoot } from '../adapters/adapter';

describe('Batch Idempotency', () => {
  beforeEach(() => {
    // Set up a mock workspace root for adapter operations
    const mockRoot = document.createElement('div');
    mockRoot.id = 'workspace-root';
    document.body.appendChild(mockRoot);
    registerWorkspaceRoot(mockRoot);
    
    // Clear workspace state between tests
    resetWorkspace();
  });

  it('computes stable hash for identical batches', () => {
    const batch1: Batch = [
      { op: 'window.create', params: { id: 'win-1', title: 'Test Window' } },
      { op: 'dom.set', params: { windowId: 'win-1', target: '#root', html: '<p>Hello</p>' } },
    ];

    const batch2: Batch = [
      { op: 'window.create', params: { id: 'win-1', title: 'Test Window' } },
      { op: 'dom.set', params: { windowId: 'win-1', target: '#root', html: '<p>Hello</p>' } },
    ];

    const hash1 = computeBatchHash(batch1);
    const hash2 = computeBatchHash(batch2);

    expect(hash1).toBe(hash2);
    expect(hash1).toBeTruthy();
  });

  it('computes different hashes for different batches', () => {
    const batch1: Batch = [
      { op: 'window.create', params: { id: 'win-1', title: 'Test Window' } },
    ];

    const batch2: Batch = [
      { op: 'window.create', params: { id: 'win-2', title: 'Different Window' } },
    ];

    const hash1 = computeBatchHash(batch1);
    const hash2 = computeBatchHash(batch2);

    expect(hash1).not.toBe(hash2);
  });

  it('applies batch on first invocation', async () => {
    const batch: Batch = [
      { op: 'window.create', params: { id: 'win-test', title: 'Test Window' } },
    ];

    const outcome = await applyBatch(batch);

    expect(outcome.success).toBe(true);
    expect(outcome.applied).toBe(1);
    expect(outcome.skippedDuplicates).toBe(0);
    expect(outcome.batchId).toBeTruthy();
    expect(outcome.errors).toHaveLength(0);
  });

  it('skips duplicate batch on second invocation', async () => {
    const batch: Batch = [
      { op: 'window.create', params: { id: 'win-dup', title: 'Duplicate Test' } },
    ];

    // First application
    const outcome1 = await applyBatch(batch);
    expect(outcome1.applied).toBe(1);
    expect(outcome1.skippedDuplicates).toBe(0);

    // Second application of identical batch (should be skipped)
    const outcome2 = await applyBatch(batch);
    expect(outcome2.success).toBe(true);
    expect(outcome2.applied).toBe(0);
    expect(outcome2.skippedDuplicates).toBe(1);
    // only skippedDuplicates remains; skippedDuplicates removed
    expect(outcome2.batchId).toBeTruthy();
    expect(outcome2.batchId).toBe(outcome1.batchId); // Original batch ID preserved for tracking
  });

  it('applies different batch with same operation type', async () => {
    const batch1: Batch = [
      { op: 'window.create', params: { id: 'win-a', title: 'Window A' } },
    ];

    const batch2: Batch = [
      { op: 'window.create', params: { id: 'win-b', title: 'Window B' } },
    ];

    const outcome1 = await applyBatch(batch1);
    expect(outcome1.applied).toBe(1);

    const outcome2 = await applyBatch(batch2);
    expect(outcome2.applied).toBe(1);
    expect(outcome2.skippedDuplicates).toBe(0);
  });

  it('handles multi-operation batch idempotency', async () => {
    const batch: Batch = [
      { op: 'window.create', params: { id: 'win-multi', title: 'Multi Window' } },
      { op: 'dom.set', params: { windowId: 'win-multi', target: '#root', html: '<p>Content</p>' } },
      { op: 'window.update', params: { id: 'win-multi', title: 'Updated Title' } },
    ];

    const outcome1 = await applyBatch(batch);
    expect(outcome1.applied).toBe(3);
    expect(outcome1.skippedDuplicates).toBe(0);

    const outcome2 = await applyBatch(batch);
    expect(outcome2.applied).toBe(0);
    expect(outcome2.skippedDuplicates).toBe(3);
    // only skippedDuplicates remains; skippedDuplicates removed
  });

  it('includes batchId in all outcomes', async () => {
    const batch: Batch = [
      { op: 'window.create', params: { id: 'win-id', title: 'ID Test' } },
    ];

    const outcome1 = await applyBatch(batch);
    expect(outcome1.batchId).toMatch(/^batch-/);

    // Duplicate batch returns the original batchId for tracking
    const outcome2 = await applyBatch(batch);
    expect(outcome2.batchId).toMatch(/^batch-/);
    expect(outcome2.batchId).toBe(outcome1.batchId);
  });

  it('resets dedupe store on workspace reset', async () => {
    const batch: Batch = [
      { op: 'window.create', params: { id: 'win-reset', title: 'Reset Test' } },
    ];

    // Apply batch
    const outcome1 = await applyBatch(batch);
    expect(outcome1.applied).toBe(1);

    // Apply duplicate (should skip)
    const outcome2 = await applyBatch(batch);
    expect(outcome2.skippedDuplicates).toBe(1);
    // only skippedDuplicates remains; skippedDuplicates removed

    // Reset workspace
    resetWorkspace();

    // Re-register workspace root after reset
    const mockRoot = document.createElement('div');
    mockRoot.id = 'workspace-root-reset';
    document.body.appendChild(mockRoot);
    registerWorkspaceRoot(mockRoot);

    // Apply batch again (should succeed after reset)
    const outcome3 = await applyBatch(batch);
    expect(outcome3.applied).toBe(1);
    expect(outcome3.skippedDuplicates).toBe(0);
  });

  it('handles empty batch gracefully', async () => {
    const batch: Batch = [];

    const outcome = await applyBatch(batch);
    expect(outcome.success).toBe(true);
    expect(outcome.applied).toBe(0);
    expect(outcome.skippedDuplicates).toBe(0);
    expect(outcome.batchId).toBeTruthy();
  });

  it('preserves original batchId when skipping duplicate', async () => {
    const batch: Batch = [
      { op: 'window.create', params: { id: 'win-preserve', title: 'Preserve ID' } },
    ];

    const outcome1 = await applyBatch(batch);
    const firstBatchId = outcome1.batchId;

    const outcome2 = await applyBatch(batch);
    // The second outcome should report the original batch's ID that was applied
    expect(outcome2.batchId).toBe(firstBatchId);
  });

  it('handles batch with trace IDs for telemetry', async () => {
    const batch: Batch = [
      { 
        op: 'window.create', 
        params: { id: 'win-trace', title: 'Trace Test' },
        traceId: 'trace-123'
      },
    ];

    const outcome1 = await applyBatch(batch);
    expect(outcome1.applied).toBe(1);

    const outcome2 = await applyBatch(batch);
    expect(outcome2.skippedDuplicates).toBe(1);
    // only skippedDuplicates remains; skippedDuplicates removed
  });

  it('skips duplicate batches when batchId is reused even with different payloads', async () => {
    const first: Batch = [
      { op: 'window.create', params: { id: 'win-batch', title: 'Batch One' } },
    ];
    const second: Batch = [
      { op: 'window.create', params: { id: 'win-batch', title: 'Batch Two' } },
    ];

    const applied = await applyBatch(first, { batchId: 'external-batch', runId: 'test-run-1' });
    expect(applied.applied).toBe(1);
    expect(applied.batchId).toBe('external-batch');

    const skipped = await applyBatch(second, { batchId: 'external-batch', runId: 'test-run-2' });
    expect(skipped.applied).toBe(0);
    expect(skipped.skippedDuplicates).toBe(second.length);
    expect(skipped.batchId).toBe('external-batch');
    expect(typeof skipped.opsHash).toBe('string');
  });
});
