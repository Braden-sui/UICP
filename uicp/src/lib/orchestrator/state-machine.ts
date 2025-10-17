export type OrchestratorState = 'idle' | 'applying';

export type OrchestratorContext = {
  state: OrchestratorState;
  runId: number;
  fullControl: boolean;
  fullControlLocked: boolean;
};

export const OrchestratorEvent = {
  StartApplying: 'StartApplying',
  ApplyComplete: 'ApplyComplete',
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
    [OrchestratorEvent.StartApplying]: 'applying',
  },
  applying: {
    [OrchestratorEvent.ApplyComplete]: 'idle',
    [OrchestratorEvent.Cancel]: 'idle',
  },
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

export const can_auto_apply = (ctx: OrchestratorContext): boolean => ctx.fullControl && !ctx.fullControlLocked && ctx.state === 'idle';
