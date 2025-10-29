import { describe, it, expect } from 'vitest';
import type { Plan, Batch } from '../../uicp/schemas';
import { validateFirstRender, validateWindowIdConsistency, validateBatchForApply } from '../validators';

const mkPlan = (summary = 'Test'): Plan => ({ summary, batch: [], risks: [], actorHints: [] });

describe('orchestrator.validators', () => {
  it('E-UICP-0406: fails when first render has dom.* and no window.create and target is not #root', () => {
    const plan = mkPlan();
    const batch: Batch = [
      { op: 'dom.set', params: { windowId: 'win-x', target: '#main', html: '<div>hi</div>' } },
    ];
    const res = validateFirstRender(plan, batch);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('E-UICP-0406');
  });

  it('E-UICP-0406: passes when first render targets #root', () => {
    const plan = mkPlan();
    const batch: Batch = [
      { op: 'dom.set', params: { windowId: 'win-x', target: '#root', html: '<div>ok</div>' } },
    ];
    const res = validateFirstRender(plan, batch);
    expect(res.ok).toBe(true);
  });

  it('E-UICP-0407: fails when window.create has no id but subsequent ops reference windowId', () => {
    const plan = mkPlan();
    const batch: Batch = [
      { op: 'window.create', params: { title: 'App' } },
      { op: 'dom.set', params: { windowId: 'win-app', target: '#root', html: 'x' } },
    ];
    const res = validateWindowIdConsistency(plan, batch);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('E-UICP-0407');
  });

  it('E-UICP-0407: fails when referenced windowId does not match created id', () => {
    const plan = mkPlan();
    const batch: Batch = [
      { op: 'window.create', params: { id: 'win-a', title: 'App' } },
      { op: 'dom.set', params: { windowId: 'win-b', target: '#root', html: 'x' } },
    ];
    const res = validateWindowIdConsistency(plan, batch);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('E-UICP-0407');
  });

  it('passes when window.create id matches referenced windowId', () => {
    const plan = mkPlan();
    const batch: Batch = [
      { op: 'window.create', params: { id: 'win-ok', title: 'App' } },
      { op: 'dom.set', params: { windowId: 'win-ok', target: '#root', html: 'x' } },
    ];
    const res = validateBatchForApply(plan, batch);
    expect(res.ok).toBe(true);
  });
});
