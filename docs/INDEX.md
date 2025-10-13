# Docs Index (Start Here)

This index lists the recommended reading order for onboarding and executing work.

## Getting Started
- docs/setup.md
  - Install, environment, run, and verification steps.

## Architecture and Contracts
- docs/architecture.md
  - Frontend/Desktop, adapter, persistence/replay, profiles, and endpoints.
- README.md
  - High-level overview, commands, environment, and architecture pointers.

## Model Usage
- docs/model-usage.md
  - Current request/response expectations for DeepSeek/Qwen/Kimi.
  - Cloud vs local endpoints and streaming.
- docs/ollama cloud vs. turbo.md
  - Cloud/native `/api/*` vs local `/v1/*` usage, examples, and auth.
- docs/Model Formatting Req.md
  - JSON-only planner/actor contract, sample payloads, and validation limits.

## Prompts (Canonical IO)
- docs/prompts/gui.md (human-readable guide)
- uicp/src/prompts/planner.txt (system prompt; exact planner contract)
- uicp/src/prompts/actor.txt (system prompt; exact actor contract)

## Compute Plane
- docs/compute/README.md (index and quick start)
- docs/compute/error-taxonomy.md
- docs/compute/test-plan.md

## Source of Truth (Status)
- docs/STATUS.md (snapshot)
  - One-page current status (Done/In Progress/Next/Risks/CI health).
- docs/MVP checklist.md (authoritative)
  - Detailed acceptance criteria and execution plan.

## Legacy (Deprecated)
- docs/legacy/Model Formatting (Harmony).md
  - Archived GPT-OSS/Harmony guidance retained for historical reference.
