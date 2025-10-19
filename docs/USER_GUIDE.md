# User Guide: Understanding UICP

## What is UICP

UICP is a local‑first desktop you build by describing what you want. The AI plans the work, then applies safe building blocks called commands. This is not a toy: it's a usable desktop for day‑to‑day flows.

## Core Concepts

### Windows
Surfaces to show content. Each window is an independent container for displaying information and interactive components.

### Commands
Small, safe steps like "set this state path" or "render this component". Commands are validated operations that modify the workspace safely.

### Planner
Decides the steps needed to accomplish your request. The planner determines what to build and in what order.

### Actor
Turns steps into exact commands that pass validation. The actor generates precise, validated commands from each plan step.

## Why Planner and Actor are Separate

### Separation of Concerns
- **Planner**: Decides what to build and in what steps. Output is a plan with targets and constraints.
- **Actor**: Turns a single step into precise, validated commands.

### Model Specialization
- **High-level reasoning** favors models like DeepSeek that excel at decomposition and constraint tracking.
- **Precise DOM and command generation** favors models like Qwen that excel at structured output and HTML.

### Safety and Determinism
- Plans are reviewed and can be simulated.
- Actors are constrained to emit only validated data-ops. Fewer chances to leak unsafe behavior.

### Testability
We can unit test the planner's plans against fixtures, and separately verify the actor's command validity and idempotence.

### Could the Actor Do Both?
Yes, but we lose the ability to verify intent before execution, prompt stability gets worse, and regressions are harder to localize. We keep the split because it improves reliability, reviewability, and speed of iteration.

## Full Control Mode

You approve plans before they run. When Full Control is **OFF**, the app shows a preview; when **ON**, it auto‑applies validated batches.

This gives you control over when the agent makes changes to your workspace.

## Reset

You can reset a window, a workspace, or the whole session.

Files in `ws:/files` are not deleted unless you choose to.
