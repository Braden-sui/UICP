import { describe, it, expect } from 'vitest';
import {
  OrchestratorEvent,
  can_auto_apply,
  create_initial_context,
  execute_transition,
  increment_run_id,
  type OrchestratorContext,
} from '../../src/lib/orchestrator/state-machine';

describe('orchestrator state machine', () => {
  const baseContext: OrchestratorContext = {
    state: 'idle',
    runId: 42,
    fullControl: true,
    fullControlLocked: false,
  };

  it('creates an initial context with idle state and runId 0', () => {
    const ctx = create_initial_context({ fullControl: false, fullControlLocked: true });
    expect(ctx).toEqual({ state: 'idle', runId: 0, fullControl: false, fullControlLocked: true });
  });

  it('increments run id and resets state to idle', () => {
    const next = increment_run_id({ ...baseContext, state: 'complete' });
    expect(next.runId).toBe(baseContext.runId + 1);
    expect(next.state).toBe('idle');
    expect(next.fullControl).toBe(baseContext.fullControl);
  });

  it('performs valid state transitions and surfaces metadata', () => {
    const { context: planningCtx, transition: planningTransition } = execute_transition(baseContext, OrchestratorEvent.StartPlanning);
    expect(planningCtx.state).toBe('planning');
    expect(planningTransition).toMatchObject({ from: 'idle', to: 'planning', event: OrchestratorEvent.StartPlanning, runId: baseContext.runId });

    const metadata = { reason: 'ready-to-apply' };
    const actingCtx: OrchestratorContext = { ...planningCtx };
    const { context: applyingCtx, transition: applyingTransition } = execute_transition(actingCtx, OrchestratorEvent.PlannerCompleted, metadata);
    expect(applyingCtx.state).toBe('acting');
    expect(applyingTransition.metadata).toBe(metadata);
  });

  it('rejects invalid transitions', () => {
    expect(() => execute_transition(baseContext, OrchestratorEvent.AutoApply)).toThrowError(/Invalid orchestrator transition/);
  });

  it('allows auto apply only during acting or previewing with unlocked full control', () => {
    expect(can_auto_apply({ ...baseContext, state: 'acting' })).toBe(true);
    expect(can_auto_apply({ ...baseContext, state: 'previewing' })).toBe(true);
    expect(can_auto_apply({ ...baseContext, state: 'planning' })).toBe(false);
    expect(can_auto_apply({ ...baseContext, state: 'acting', fullControlLocked: true })).toBe(false);
    expect(can_auto_apply({ ...baseContext, state: 'acting', fullControl: false })).toBe(false);
  });
});
