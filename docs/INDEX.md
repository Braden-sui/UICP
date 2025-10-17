# Docs Index (Start Here)

This index lists the recommended reading order for onboarding and executing work.

## Quick Reference

**Source of Truth**:

- `MVP checklist.md` - Authoritative acceptance criteria and execution plan
- `STATUS.md` - Current snapshot (Done/In Progress/Next/Risks/CI health)

**Getting Started**:

- `setup.md` - Install, environment, run, and verification steps
- `USER_GUIDE.md` - User-facing concepts and controls
- `../README.md` - High-level overview and quick commands

## Architecture & Core Systems

**System Architecture**:

- `architecture.md` - Frontend/Desktop, adapter, persistence/replay, profiles, and endpoints
- `CONCEPTS.md` - Planner vs Actor separation rationale

**State & Testing**:

- `memory.md` - State management and persistence
- `TEST_PLAN_LEAN.md` - Test scoping template

## Model Integration

**Model Configuration**:

- `model-usage.md` - Request/response expectations for DeepSeek/Qwen/Kimi
- `MODEL_CHOICES.md` - Model selection guidance
- `ollama cloud vs. turbo.md` - Cloud `/api/*` vs local `/v1/*` endpoints, auth

**Contracts & Schemas**:

- `Model Formatting Req.md` - JSON planner/actor contract, validation limits
- `json-ref.md` - JSON schema reference
- `prompts/gui.md` - Human-readable guide
- `../uicp/src/prompts/planner.txt` - Exact planner system prompt
- `../uicp/src/prompts/actor.txt` - Exact actor system prompt

## Compute Plane (WASM)

**Entry Point**:

- `compute/README.md` - Index, quick start, and master checklist
- `compute/WIL.md` - Words→Intent→LEXICON deterministic mapping

**Reference**:

- `compute/error-taxonomy.md` - Error codes and handling
- `compute/cache-maintenance.md` - SQLite maintenance and schema versioning
- `compute/troubleshooting.md` - Common issues and solutions

**Testing & CI**:

- `compute/test-plan.md` - Compute-specific test strategy
- `compute/COMPLETE_TEST_AUDIT.md` - Test coverage audit
- `../uicp/components/*/wit/` - WIT contracts for compute modules

## Observability & Performance

**Telemetry**:

- `telemetry-id-tracking.md` - Trace/Batch/Run correlation guide

**Performance**:

- `speed.md` - Completed runtime improvements (October 2025)
- `speed-enhancement-proposals.md` - Performance analysis and backlog

## Implementation History

**Current Work**:

- `IMPLEMENTATION_LOG.md` - Consolidated implementation milestones (October 2025)
- `2025-10-17-type-fidelity-boundary.md` - Recent boundary documentation

**Planning**:

- `BACKLOG.md` - Post-MVP features
- `V1 Acceptance.md` - V1 acceptance criteria and sign-off template

**Archives**:

- `archive/2025-10/` - Dated implementation notes (consolidated into IMPLEMENTATION_LOG)
- `legacy/` - Deprecated guidance (GPT-OSS/Harmony)
