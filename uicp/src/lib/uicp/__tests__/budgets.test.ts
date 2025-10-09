import { describe, it, expect } from 'vitest';
import { validateBatch } from '../schemas';

describe('batch budgets', () => {
  it('rejects batches over 64 operations', () => {
    const batch = Array.from({ length: 65 }, (_, i) => ({
      op: 'state.set' as const,
      params: { scope: 'workspace', key: `k${i}`, value: i },
    }));
    expect(() => validateBatch(batch)).toThrowError(/batch too large \(max 64 operations\)/i);
  });

  it('rejects total HTML length over 128KB across dom ops', () => {
    const big = 'x'.repeat(129 * 1024);
    const batch = [
      { op: 'window.create' as const, params: { title: 't' } },
      { op: 'dom.set' as const, params: { windowId: 'win-a', target: '#root', html: big } },
    ];
    expect(() => validateBatch(batch)).toThrowError(/total HTML too large/i);
  });
});
