---
description: two-phase planner protocol
---
# Two-Phase Planner Protocol

## Overview
The existing planner performed a single pass over raw user intent and emitted a `PlannerPlan` directly. The new protocol introduces an explicit TaskSpec phase that normalizes user intent before planning. Both phases are executed by the same LLM agent in sequence.

```
User text
  → Phase 1: Prompt Optimization → TaskSpec JSON
  → Phase 2: Standard Planning   → PlannerPlan JSON
  → Actor (PlannerPlan as source of truth, TaskSpec as hint)
```

## Phase 1 — TaskSpec Generation
- **Goal**: Convert arbitrary user text into a structured `TaskSpec` that captures intent, goals, constraints, artifacts, contextual hints, and measurable acceptance criteria.
- **Prompt**: `prompts/planner_task_spec.txt`
- **Validation**: Parsed via `TaskSpecSchema` to guarantee shape and values.
- **Repair**: Invalid JSON triggers a repair prompt and one retry.
- **Output**: Stored in orchestrator state and forwarded to Phase 2 and the actor.

### TaskSpec JSON Shape
```
{
  "user_intent": string,
  "goals": string[],
  "constraints": string[],
  "artifacts": string[],
  "contexts": string[],
  "actions": [
    { "tool": string, "params": { ... }, "description"?: string, "reason"?: string }
  ],
  "acceptance": string[],
  "priority": "low" | "normal" | "high"
}
```

## Phase 2 — PlannerPlan Generation
- **Goal**: Produce the existing planner output using the TaskSpec as anchor context.
- **Prompt**: `prompts/planner.txt` augmented with TaskSpec and tool registry.
- **Validation**: `PlannerPlanSchema` extends the legacy plan schema (summary, assumptions, preconditions, steps, acceptance, rollback).
- **Output**: Provided to the actor as the authoritative plan. TaskSpec is forwarded as a hint.

## Orchestration Changes
1. `runIntent()` now executes `generateTaskSpec()` before `planWithProfile()`.
2. Orchestrator telemetry includes both TaskSpec and PlannerPlan metadata.
3. Actor entrypoint receives `{ plan, batch, taskSpec }`.
4. UI previews and auto-apply logic remain unchanged.

## Failure Handling
- **TaskSpec invalid**: Repair prompt retry; on repeated failure, fall back to a minimal stub TaskSpec.
- **Phase 2 failure**: Existing planner fallback workflow reused.
- **Actor failure**: Unchanged; TaskSpec remains available for manual debugging.

## Testing
- `TaskSpec` parsing unit tests with valid/invalid payloads.
- `runIntent` integration test verifying both phases and actor handoff.
- Snapshot tests for prompts (Phase 1 + Phase 2) to detect drift.

## Telemetry
- `planner_taskspec_start/finish` events capture TaskSpec timing and validity.
- Existing `planner_start/finish` events now include TaskSpec priority and goal counts.

## Rollout Notes
- The protocol is backward-compatible; actor logic tolerates absence of TaskSpec (legacy runs default to stub).
- Feature flag `VITE_PLANNER_TWO_PHASE` can disable Phase 1 if required (default: enabled).
