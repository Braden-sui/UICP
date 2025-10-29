export type OrchestratorState =
  | 'idle'
  | 'planning'
  | 'acting'
  | 'previewing'
  | 'applying'
  | 'complete'
  | 'cancelled';

export type OrchestratorContext = {
  state: OrchestratorState;
  runId: number;
  fullControl: boolean;
  fullControlLocked: boolean;
};

export const OrchestratorEvent = {
  StartPlanning: 'StartPlanning',
  PlannerCompleted: 'PlannerCompleted',
  PlannerFailed: 'PlannerFailed',
  RequirePreview: 'RequirePreview',
  ApplyStart: 'ApplyStart',
  AutoApply: 'AutoApply',
  PreviewAccepted: 'PreviewAccepted',
  ApplySucceeded: 'ApplySucceeded',
  ApplyFailed: 'ApplyFailed',
  Cancel: 'Cancel',
} as const;
export type OrchestratorEventName = typeof OrchestratorEvent[keyof typeof OrchestratorEvent];

export type StateTransition = {
  from: OrchestratorState;
  to: OrchestratorState;
  event: OrchestratorEventName;
  runId: number;
  metadata?: Record<string, unknown>;
};

type ExecuteResult = {
  context: OrchestratorContext;
  transition: StateTransition;
};

const transitionTable: Record<OrchestratorState, Partial<Record<OrchestratorEventName, OrchestratorState>>> = {
  idle: {
    [OrchestratorEvent.StartPlanning]: 'planning',
  },
  planning: {
    [OrchestratorEvent.PlannerCompleted]: 'acting',
    [OrchestratorEvent.PlannerFailed]: 'cancelled',
    [OrchestratorEvent.Cancel]: 'cancelled',
  },
  acting: {
    [OrchestratorEvent.RequirePreview]: 'previewing',
    [OrchestratorEvent.ApplyStart]: 'applying',
    [OrchestratorEvent.AutoApply]: 'applying',
    [OrchestratorEvent.Cancel]: 'cancelled',
  },
  previewing: {
    [OrchestratorEvent.ApplyStart]: 'applying',
    [OrchestratorEvent.PreviewAccepted]: 'applying',
    [OrchestratorEvent.Cancel]: 'cancelled',
  },
  applying: {
    [OrchestratorEvent.ApplySucceeded]: 'complete',
    [OrchestratorEvent.ApplyFailed]: 'cancelled',
    [OrchestratorEvent.Cancel]: 'cancelled',
  },
  complete: {},
  cancelled: {},
};

export const create_initial_context = (opts: { fullControl: boolean; fullControlLocked: boolean }): OrchestratorContext => ({
  state: 'idle',
  runId: 0,
  fullControl: opts.fullControl,
  fullControlLocked: opts.fullControlLocked,
});

export const increment_run_id = (ctx: OrchestratorContext): OrchestratorContext => ({
  ...ctx,
  runId: ctx.runId + 1,
  state: 'idle',
});

export const execute_transition = (
  ctx: OrchestratorContext,
  event: OrchestratorEventName,
  metadata?: Record<string, unknown>,
): ExecuteResult => {
  const nextState = transitionTable[ctx.state]?.[event];
  if (!nextState) {
    throw new Error(`Invalid orchestrator transition: ${ctx.state} -> ${event}`);
  }
  const nextContext: OrchestratorContext = {
    ...ctx,
    state: nextState,
  };
  const transition: StateTransition = {
    from: ctx.state,
    to: nextState,
    event,
    runId: ctx.runId,
    metadata,
  };
  return { context: nextContext, transition };
};

export const can_auto_apply = (ctx: OrchestratorContext): boolean => {
  if (!ctx.fullControl || ctx.fullControlLocked) return false;
  return ctx.state === 'acting' || ctx.state === 'previewing';
};
