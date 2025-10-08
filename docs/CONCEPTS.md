Concepts: Planner vs Actor

Why Planner and Actor are separate

Separation of concerns

- Planner: decides what to build and in what steps. Output is a plan with targets and constraints.
- Actor: turns a single step into precise, validated commands.

Model specialization

- High-level reasoning favors models like DeepSeek that excel at decomposition and constraint tracking.
- Precise DOM and command generation favors models like Qwen that excel at structured output and HTML.

Safety and determinism

- Plans are reviewed and can be simulated.
- Actors are constrained to emit only validated data-ops. Fewer chances to leak unsafe behavior.

Testability

- We can unit test the planner’s plans against fixtures, and separately verify the actor’s command validity and idempotence.

Could the Actor do both?

Yes, but we lose the ability to verify intent before execution, prompt stability gets worse, and regressions are harder to localize. We keep the split because it improves reliability, reviewability, and speed of iteration.

