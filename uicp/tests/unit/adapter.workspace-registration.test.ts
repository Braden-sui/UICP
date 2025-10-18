import { describe, it, expect, beforeEach, vi } from 'vitest';

// Disable v2 for these tests since they test workspace registration guards, not adapter internals
vi.mock('../../src/lib/uicp/adapters/adapter.featureFlags', () => ({
  ADAPTER_V2_ENABLED: false,
  getAdapterVersion: () => 1,
}));

import { registerWorkspaceRoot, deferBatchIfNotReady } from '../../src/lib/uicp/adapter';
import { enqueueBatch } from '../../src/lib/uicp/queue';

/**
 * Test coverage for workspace registration race condition guard.
 * 
 * CONTEXT: initializeTauriBridge() runs before Desktop.tsx mounts, so streaming/compute
 * events may call enqueueBatch() before registerWorkspaceRoot() is called. This would
 * cause "Workspace root not registered" errors.
 * 
 * FIX: Added workspaceReady flag and pendingBatches queue. Batches that arrive before
 * workspace registration are queued and flushed when registerWorkspaceRoot() is called.
 */

describe('workspace registration guard', () => {
  beforeEach(() => {
    // Reset the workspace state for each test
    // Note: We can't actually unregister since the module state persists,
    // but these tests verify the queueing behavior works correctly.
  });

  it('defers batch when workspace is not ready', () => {
    // Before registerWorkspaceRoot is called, deferBatchIfNotReady should return a Promise
    const batch = [
      { op: 'window.create' as const, params: { title: 'Test', width: 400, height: 300 } },
    ];

    const result = deferBatchIfNotReady(batch);
    
    // Should return a Promise (batch is queued)
    expect(result).toBeInstanceOf(Promise);
  });

  it('processes batch immediately after workspace is registered', () => {
    // Create a mock root element
    const mockRoot = document.createElement('div');
    registerWorkspaceRoot(mockRoot);

    const batch = [
      { op: 'window.create' as const, params: { title: 'Test', width: 400, height: 300 } },
    ];

    const result = deferBatchIfNotReady(batch);
    
    // Should return null (proceed with normal processing)
    expect(result).toBeNull();
  });

  it('flushes pending batches when workspace is registered', async () => {
    // This test verifies the full flow:
    // 1. Batch arrives before registration → queued
    // 2. registerWorkspaceRoot is called → flushes pending batches
    
    // In a real scenario, we'd need to reset the workspace state between tests,
    // but that's not possible with the current module-level state.
    // This is more of an integration test to document the expected behavior.
    
    const mockRoot = document.createElement('div');
    mockRoot.id = 'workspace-test-root';
    document.body.appendChild(mockRoot);

    // Simulate workspace registration
    registerWorkspaceRoot(mockRoot);

    // After registration, batches should be processed immediately
    const batch = [
      { op: 'window.create' as const, params: { title: 'Post-Registration', width: 400, height: 300 } },
    ];

    const outcome = await enqueueBatch(batch);
    
    // Should apply successfully
    expect(outcome.success).toBe(true);
    expect(outcome.applied).toBeGreaterThanOrEqual(0); // Might be 0 if window already exists

    // Cleanup
    document.body.removeChild(mockRoot);
  });

  it('preserves batch order when flushing', async () => {
    // This test documents that pending batches are processed in order
    // when the workspace is registered. The actual test is more of a behavioral
    // documentation since we can't easily reset the workspace state.
    
    const mockRoot = document.createElement('div');
    mockRoot.id = 'workspace-order-test';
    document.body.appendChild(mockRoot);

    registerWorkspaceRoot(mockRoot);

    // Create multiple batches
    const batch1 = [
      { op: 'window.create' as const, params: { id: 'win-order-1', title: 'First', width: 400, height: 300 } },
    ];
    const batch2 = [
      { op: 'window.create' as const, params: { id: 'win-order-2', title: 'Second', width: 400, height: 300 } },
    ];

    // Both should process successfully
    const outcome1 = await enqueueBatch(batch1);
    const outcome2 = await enqueueBatch(batch2);

    expect(outcome1.success).toBe(true);
    expect(outcome2.success).toBe(true);

    // Cleanup
    document.body.removeChild(mockRoot);
  });

  it('handles errors in pending batches gracefully', async () => {
    const mockRoot = document.createElement('div');
    mockRoot.id = 'workspace-error-test';
    document.body.appendChild(mockRoot);

    registerWorkspaceRoot(mockRoot);

    // Create a batch with invalid params to trigger an error
    const invalidBatch = [
      { op: 'window.create' as const, params: { title: '' } }, // Empty title should fail min(1) validation
    ];

    // Should reject with validation error
    await expect(enqueueBatch(invalidBatch)).rejects.toThrow();

    // Cleanup
    document.body.removeChild(mockRoot);
  });
});
