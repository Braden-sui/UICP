# UICP Documentation

**Status**: October 19, 2025 - Production

---

## Quick Navigation

### Core Documentation

- **[ADAPTER_V2_COMPLETE.md](ADAPTER_V2_COMPLETE.md)** - Adapter v2 architecture (complete)
- **[STATUS.md](STATUS.md)** - Current project status
- **[USER_GUIDE.md](USER_GUIDE.md)** - User guide and core concepts

### Implementation

- **[IMPLEMENTATION_LOG.md](IMPLEMENTATION_LOG.md)** - Major milestones and changes
- **[setup.md](setup.md)** - Development environment setup

### Technical

- **[architecture.md](architecture.md)** - System architecture overview
- **[architecture/](architecture/)** - Detailed architecture docs
  - [planner_taskspec_v2.md](architecture/planner_taskspec_v2.md) — consolidated planner/taskspec
- **[compute/](compute/)** - Compute plane documentation
  - [testing.md](compute/testing.md) — consolidated compute testing
- **[telemetry-id-tracking.md](telemetry-id-tracking.md)** - Tracing and observability

### Reference

- **[PROPOSALS.md](PROPOSALS.md)** - Potential future work (non-committal)
- **[MODEL_INTEGRATION.md](MODEL_INTEGRATION.md)** - Provider integration and verification
- **[MODEL_CHOICES.md](MODEL_CHOICES.md)** - LLM model selection
- **[KNOWN_ISSUES.md](KNOWN_ISSUES.md)** - Current known issues and workarounds
- This page serves as the docs index

---

## What is UICP?

UICP is a local-first desktop environment that you build through natural language descriptions. Key features:

- **Windows**: Containers for displaying content
- **Commands**: Safe, validated operations (window create, DOM set, component render)
- **Planner**: AI that determines the steps needed
- **Actor**: AI that generates precise commands
- **Full Control Mode**: Approve plans before execution
- **Model-Agnostic Profiles**: Switch between different LLM providers without code changes

---

## Test Status

```
✅ 382 tests passing (85 test files)
⚠️  1 test failing (agents loader)
✅ TypeScript: 0 errors
✅ Lint: 0 errors
```

Note: One test in `agents/loader.test.ts` currently fails due to yaml dependency issue.

---

## Key Decisions

### Adapter V2 (Complete)
- V1 monolith removed (971 lines deleted)
- V2 modular architecture (14 modules, ~1,800 lines)
- 100% test coverage before v1 removal
- No rollback available - v2 is the only implementation

### Tool Calling (Active)
- JSON-first with WIL fallback
- Model-agnostic profiles (select at runtime)
- `supportsTools: true` for structured output
- >90% tool success rate

---

## For Contributors

### Running Tests
```bash
cd uicp
pnpm test               # All tests
pnpm run typecheck      # Type checking
pnpm run lint           # Linting
```

### Project Structure
```
uicp/
  src/
    lib/
      uicp/
        adapters/      # Adapter v2 modules
        schema/        # Operation schemas
      llm/            # LLM providers
      wil/            # WIL parser
    state/            # Zustand stores
    components/       # React components
  tests/              # Unit & integration tests
```

---

**For detailed information, see individual documentation files linked above.**



