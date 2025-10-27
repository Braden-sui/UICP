# Model Choices and Profiles

Last updated: 2025-10-26

Purpose: map planner/actor profiles to default models and note where overrides are applied.

Sources
- Profiles: `uicp/src/lib/llm/profiles.ts`
- Orchestrator model mapping: `uicp/src/lib/llm/orchestrator.ts`

Planner profiles (defaultModel)
- wil → (none; deterministic WIL planner)
- glm → `glm-4.6:cloud`
- gpt-oss → `gpt-oss:120b`
- deepseek → `deepseek-v3.1:671b`
- kimi → `kimi-k2:1t`
- qwen → `qwen3-coder:480b`

Actor profiles (default selection)
The orchestrator selects an actor model by profile key:
- qwen → `qwen3-coder:480b`
- deepseek → `deepseek-v3.1:671b`
- glm → `glm-4.6:cloud`
- gpt-oss → `gpt-oss:120b`
- kimi → `kimi-k2:latest`
- default → `qwen3-coder:480b`

Overrides
- A specific model can be provided via orchestrator options (`modelOverride`) or YAML profiles mode (`agents.yaml`) when enabled.

Notes
- Capabilities for each profile (channels, tool support) are defined in `profiles.ts` and guide tool vs. text/WIL output modes.

