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

  it('E-UICP-0408: fails when dynamic cues present without needs.code or code component', () => {
    const plan = mkPlan();
    const batch: Batch = [
      { op: 'window.create', params: { id: 'win-a', title: 'App' } },
      {
        op: 'dom.set',
        params: {
          windowId: 'win-a',
          target: '#root',
          html: '<button data-command="say-hi">Hi</button>',
        },
      },
    ];
    const res = validateBatchForApply(plan, batch);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('E-UICP-0408');
  });

  it('passes when needs.code marker is included', () => {
    const plan = mkPlan();
    const batch: Batch = [
      { op: 'needs.code', params: { spec: 'test spec', language: 'ts', provider: 'auto', strategy: 'sequential-fallback' } },
      { op: 'window.create', params: { id: 'win-a', title: 'App' } },
      {
        op: 'dom.append',
        params: {
          windowId: 'win-a',
          target: '#root',
          html: '<form onsubmit="return false"><input /></form>',
        },
      },
    ];
    const res = validateBatchForApply(plan, batch);
    expect(res.ok).toBe(true);
  });

  it('passes when a code/applet component is present', () => {
    const plan = mkPlan();
    const batch: Batch = [
      { op: 'window.create', params: { id: 'win-a', title: 'App' } },
      {
        op: 'component.render',
        params: { id: 'comp-a', windowId: 'win-a', target: '#root', type: 'applet.quickjs', props: { script: 'counter-applet' } },
      },
      {
        op: 'dom.replace',
        params: {
          windowId: 'win-a',
          target: '#root',
          html: '<div><button onclick="void 0">Click</button></div>',
        },
      },
    ];
    const res = validateBatchForApply(plan, batch);
    expect(res.ok).toBe(true);
  });

  it('passes for static DOM-only content without dynamic cues', () => {
    const plan = mkPlan();
    const batch: Batch = [
      { op: 'window.create', params: { id: 'win-a', title: 'Static' } },
      { op: 'dom.set', params: { windowId: 'win-a', target: '#root', html: '<div>hello</div>' } },
    ];
    const res = validateBatchForApply(plan, batch);
    expect(res.ok).toBe(true);
  });
});
