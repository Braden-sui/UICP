# Agents: Config, Schema, Loader

Last updated: 2025-10-26

Purpose: where the desktop stores and loads agent configuration, how to edit it, and the runtime APIs available.

## File Location
- Resolved via Tauri 2 path API inside `agents_config_path(app)`.
- Layout: `<app_data_dir>/uicp/agents.yaml`.
- Backend commands:
  - `load_agents_config_file(app)` → reads file, returns `{ exists, contents, path }`.
  - `save_agents_config_file(app, contents)` → validates size and writes.

See implementation in: `uicp/src-tauri/src/main.rs:agents_config_path` and Tauri commands nearby.

## Format
- YAML document containing agent definitions that your loader uses to bootstrap capabilities.
- Validation helpers: `uicp/src/lib/agents/schema.ts`.
- Loader: `uicp/src/lib/agents/loader.ts`.

## Editing from the UI
- The desktop exposes open/save flows under Agent Settings.
- For power users, edit the file at the path returned by `load_agents_config_file`.

## Limits and Safety
- Max size: 512 KiB (`AGENTS_CONFIG_MAX_SIZE_BYTES`).
- Writes are rejected when above the cap with `E-UICP-AGENTS-SIZE`.

## Example (agents.yaml)

```
version: "1"
defaults:
  temperature: 0.2
  top_p: 1.0
  max_tokens: 4096
  json_mode: true
  tools_enabled: true
providers:
  anthropic:
    base_url: https://api.anthropic.com
    headers:
      x-api-key: "$ANTHROPIC_API_KEY"
    model_aliases:
      planner: { id: claude-3-5-sonnet-latest, limits: { max_output_tokens: 4000 } }
      actor: { id: claude-3-5-sonnet-latest }
  openai:
    base_url: https://api.openai.com/v1
    headers:
      authorization: "Bearer $OPENAI_API_KEY"
    model_aliases:
      gpt4o: gpt-4o-mini
profiles:
  planner:
    provider: anthropic
    model: planner
    temperature: 0.2
    max_tokens: 4096
    fallbacks: ["openai:gpt4o"]
  actor:
    provider: anthropic
    model: actor
    temperature: 0.2
    max_tokens: 4096
codegen:
  engine: cli
  allow_paid_fallback: false
```
