import { describe, it, expect } from 'vitest';
import {
  create_initial_context,
  execute_transition,
  OrchestratorEvent,
  can_auto_apply,
  increment_run_id,
  type OrchestratorContext,
} from '../state-machine';

const makeCtx = (
  state: OrchestratorContext['state'] = 'idle',
  fullControl = true,
  fullControlLocked = false,
  runId = 1,
): OrchestratorContext => ({ state, runId, fullControl, fullControlLocked });

describe('orchestrator.state-machine', () => {
  it('create_initial_context starts idle with runId 0', () => {
    const ctx = create_initial_context({ fullControl: true, fullControlLocked: false });
    expect(ctx.state).toBe('idle');
    expect(ctx.runId).toBe(0);
  });

  it('idle -> StartPlanning -> planning', () => {
    const res = execute_transition(makeCtx('idle'), OrchestratorEvent.StartPlanning);
    expect(res.context.state).toBe('planning');
    expect(res.transition.from).toBe('idle');
    expect(res.transition.to).toBe('planning');
  });

  it('planning -> PlannerCompleted -> acting', () => {
    const res = execute_transition(makeCtx('planning'), OrchestratorEvent.PlannerCompleted);
    expect(res.context.state).toBe('acting');
  });

  it('planning -> PlannerFailed -> cancelled', () => {
    const res = execute_transition(makeCtx('planning'), OrchestratorEvent.PlannerFailed);
    expect(res.context.state).toBe('cancelled');
  });

  it('acting -> RequirePreview -> previewing', () => {
    const res = execute_transition(makeCtx('acting'), OrchestratorEvent.RequirePreview);
    expect(res.context.state).toBe('previewing');
  });

  it('acting -> ApplyStart -> applying', () => {
    const res = execute_transition(makeCtx('acting'), OrchestratorEvent.ApplyStart);
    expect(res.context.state).toBe('applying');
  });

  it('previewing -> ApplyStart -> applying', () => {
    const res = execute_transition(makeCtx('previewing'), OrchestratorEvent.ApplyStart);
    expect(res.context.state).toBe('applying');
  });

  it('previewing -> PreviewAccepted -> applying', () => {
    const res = execute_transition(makeCtx('previewing'), OrchestratorEvent.PreviewAccepted);
    expect(res.context.state).toBe('applying');
  });

  it('applying -> ApplySucceeded -> complete', () => {
    const res = execute_transition(makeCtx('applying'), OrchestratorEvent.ApplySucceeded);
    expect(res.context.state).toBe('complete');
  });

  it('applying -> ApplyFailed -> cancelled', () => {
    const res = execute_transition(makeCtx('applying'), OrchestratorEvent.ApplyFailed);
    expect(res.context.state).toBe('cancelled');
  });

  it('Cancel works from planning/acting/previewing/applying', () => {
    expect(execute_transition(makeCtx('planning'), OrchestratorEvent.Cancel).context.state).toBe('cancelled');
    expect(execute_transition(makeCtx('acting'), OrchestratorEvent.Cancel).context.state).toBe('cancelled');
    expect(execute_transition(makeCtx('previewing'), OrchestratorEvent.Cancel).context.state).toBe('cancelled');
    expect(execute_transition(makeCtx('applying'), OrchestratorEvent.Cancel).context.state).toBe('cancelled');
  });

  it('invalid transition throws typed error', () => {
    expect(() => execute_transition(makeCtx('acting'), OrchestratorEvent.ApplySucceeded)).toThrowError(
      /Invalid orchestrator transition/,
    );
  });

  it('can_auto_apply only when fullControl true and state is acting or previewing', () => {
    expect(can_auto_apply(makeCtx('acting', true, false))).toBe(true);
    expect(can_auto_apply(makeCtx('previewing', true, false))).toBe(true);
    expect(can_auto_apply(makeCtx('acting', false, false))).toBe(false);
    expect(can_auto_apply(makeCtx('acting', true, true))).toBe(false);
    expect(can_auto_apply(makeCtx('planning', true, false))).toBe(false);
  });

  it('increment_run_id bumps runId and resets state to idle', () => {
    const before = makeCtx('complete', true, false, 7);
    const after = increment_run_id(before);
    expect(after.runId).toBe(8);
    expect(after.state).toBe('idle');
  });
});
