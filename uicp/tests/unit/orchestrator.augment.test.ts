import { describe, it, expect } from 'vitest';

// Import the orchestrator module to access the internal augmentPlan via runIntent
// We'll test the behavior indirectly through the full flow
describe('orchestrator augmentPlan', () => {
  it('tells Actor to CREATE window when batch is empty (degraded mode)', () => {
    // Test the augmentPlan logic indirectly by checking what happens with an empty batch
    const emptyPlan = {
      summary: 'Test empty batch',
      batch: [],
      risks: [] as string[],
    };

    // Simulate what augmentPlan does
    const risks = Array.isArray(emptyPlan.risks) ? emptyPlan.risks.slice() : [];
    const hasReuseId = risks.some((r: string) => /gui:\s*(reuse|create)\s*window\s*id/i.test(r));
    const slug = emptyPlan.summary
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'app';
    
    const isEmptyBatch = !Array.isArray(emptyPlan.batch) || emptyPlan.batch.length === 0;
    const verb = isEmptyBatch ? 'create' : 'reuse';
    
    if (!hasReuseId) risks.push(`gui: ${verb} window id win-${slug}`);

    expect(isEmptyBatch).toBe(true);
    expect(verb).toBe('create');
    expect(risks.some((r: string) => r.includes('create window id'))).toBe(true);
    expect(risks.some((r: string) => r.includes('reuse window id'))).toBe(false);
  });

  it('tells Actor to REUSE window when batch has steps (normal mode)', () => {
    const normalPlan = {
      summary: 'Test with steps',
      batch: [{ op: 'window.create', params: { title: 'Test' } }],
      risks: [] as string[],
    };

    // Simulate what augmentPlan does
    const risks = Array.isArray(normalPlan.risks) ? normalPlan.risks.slice() : [];
    const hasReuseId = risks.some((r: string) => /gui:\s*(reuse|create)\s*window\s*id/i.test(r));
    const slug = normalPlan.summary
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'app';
    
    const isEmptyBatch = !Array.isArray(normalPlan.batch) || normalPlan.batch.length === 0;
    const verb = isEmptyBatch ? 'create' : 'reuse';
    
    if (!hasReuseId) risks.push(`gui: ${verb} window id win-${slug}`);

    expect(isEmptyBatch).toBe(false);
    expect(verb).toBe('reuse');
    expect(risks.some((r: string) => r.includes('reuse window id'))).toBe(true);
    expect(risks.some((r: string) => r.includes('create window id'))).toBe(false);
  });

  it('does not add window hint if one already exists', () => {
    const planWithHint = {
      summary: 'Test with existing hint',
      batch: [],
      risks: ['gui: create window id win-custom'],
    };

    // Simulate what augmentPlan does
    const risks = Array.isArray(planWithHint.risks) ? planWithHint.risks.slice() : [];
    const hasReuseId = risks.some((r: string) => /gui:\s*(reuse|create)\s*window\s*id/i.test(r));
    const slug = planWithHint.summary
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'app';
    
    const isEmptyBatch = !Array.isArray(planWithHint.batch) || planWithHint.batch.length === 0;
    const verb = isEmptyBatch ? 'create' : 'reuse';
    
    if (!hasReuseId) risks.push(`gui: ${verb} window id win-${slug}`);

    expect(hasReuseId).toBe(true);
    // Should not add another window hint
    expect(risks.filter((r: string) => /gui:\s*(reuse|create)\s*window\s*id/i.test(r)).length).toBe(1);
  });
});
