Model Choices (Decision Matrix)

Use case / Best default / Why / Notes

- High-level planning, multi-step decomposition → DeepSeek → good at step breakdown and constraint juggling → Planner role.
- Precise DOM and command emission → Qwen → strong structured output and HTML → Actor role.
- Long context or code intelligence tasks → GPT-OSS or Alt X → when the context window or repos are huge → behind a stable formatter.
- Cost sensitive bulk ops → Lite model → for cheap batch jobs → only for non-critical path.

Channel flow (simple)

Planner → (plan.json) → Actor → (commands[]) → Adapter → (apply, persist) → Desktop.

One-liners per channel

- Planner: decomposes intent into auditable steps.
- Actor: emits precise, validated commands.
- Adapter: applies stateful UI changes safely and persists.
- Desktop: renders windows, components, and state.

