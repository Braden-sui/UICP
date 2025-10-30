# Agent Architecture Implementation Plan
## Native Tauri API Integration for AI Agents

**Document Version:** 1.1
**Last Updated:** 2025-10-29
**Author:** Implementation Planning Team
**Status:** Draft for Review

**Revision 1.1 Changes:**
- Removed overly-restrictive state namespace isolation
- Changed security model to leverage existing UICP permission system
- Updated rate limiting to focus on abuse prevention, not artificial caps
- Clarified that agents collaborate via shared state
- Updated security tests to validate existing policy enforcement

---

## Executive Summary

This document outlines a comprehensive strategy for implementing agent interaction with the UICP platform using native Tauri APIs instead of DOM manipulation. The goal is to create a robust, secure, and performant agent system that leverages existing UICP infrastructure while maintaining architectural consistency.

**Key Objectives:**
- Enable AI agents to interact with UICP through native command APIs
- Maintain security boundaries and policy enforcement
- Preserve existing adapter architecture and lifecycle management
- Support multi-agent orchestration via ruv-swarm MCP
- Use Playwright exclusively for UI testing (not agent interaction)

**Expected Outcomes:**
- 40-60% performance improvement over DOM manipulation
- Agents leverage existing UICP security (no new restrictive layers)
- Flexible agent collaboration via shared state and windows
- Reduced brittleness from UI changes
- Clear separation between agent APIs and testing infrastructure

---

## Table of Contents

1. [Current Architecture Analysis](#1-current-architecture-analysis)
2. [Problem Statement](#2-problem-statement)
3. [Proposed Architecture](#3-proposed-architecture)
4. [API Design](#4-api-design)
5. [Implementation Phases](#5-implementation-phases)
6. [Security Model](#6-security-model)
7. [Testing Strategy](#7-testing-strategy)
8. [Migration Path](#8-migration-path)
9. [Risk Mitigation](#9-risk-mitigation)
10. [Success Metrics](#10-success-metrics)
11. [References](#11-references)

---

## 1. Current Architecture Analysis

### 1.1 Existing Components

**Core Systems:**
- **Adapter System** (`src/lib/uicp/adapters/`)
  - Event delegation via `adapter.events.ts`
  - Lifecycle management via `lifecycle.ts`
  - Command routing via `registerCommandHandler()`
  - State management (window/workspace/global scopes)

- **Window Management**
  - Window creation, focus, move, resize operations
  - Lifecycle listeners for window events
  - Z-index and positioning management

- **Compute System** (`src-tauri/src/commands.rs`, `src-tauri/src/compute.rs`)
  - Sandboxed WASM module execution
  - Policy enforcement (`enforce_compute_policy`)
  - Job queue with concurrency control
  - Cache system for compute results

- **Permission System**
  - Permission gates for operations
  - Capability-based security (fs_read, fs_write, net, etc.)
  - Policy version tracking

**Key Files:**
- `uicp/src/lib/uicp/adapters/adapter.events.ts` - Event delegation and command handlers
- `uicp/src/lib/uicp/adapters/lifecycle.ts` - Workspace and window lifecycle (2003 lines)
- `uicp/src-tauri/src/commands.rs` - Tauri command implementations
- `uicp/src-tauri/src/main.rs` - Application entry point with command registration

### 1.2 Current Agent Interaction Model

**As-Is State:**
Currently, no formal agent API exists. The proposed Playwright integration would:
- Use DOM selectors to find UI elements
- Simulate click/input events
- Parse visual state from DOM
- **Problem:** Bypasses security policies, breaks on UI changes, slow execution

**Existing Command Infrastructure:**
UICP already has a command system that agents can leverage:
```typescript
// From adapter.events.ts
registerCommandHandler('script.emit', async (cmd, ctx) => { ... });
registerCommandHandler('ui.agent-settings.open', async () => { ... });
registerCommandHandler('compute.cancel', async (cmd, ctx) => { ... });
```

**Batch Operation System:**
```typescript
// Operations are applied in batches with idempotency
const batch: Batch = [
  { op: 'window.create', params: { id: 'agent-window', title: 'Agent Output' } },
  { op: 'dom.set', params: { windowId: 'agent-window', target: '#root', html: '<div>...</div>' } },
  { op: 'state.set', params: { scope: 'workspace', key: 'agent.status', value: 'running' } }
];
await applyBatch(batch);
```

### 1.3 Strengths to Preserve

1. **Security-First Design**
   - All operations go through policy enforcement
   - Capability-based security model
   - Sandbox isolation for compute tasks

2. **Event Architecture**
   - Centralized event delegation
   - Command handler registry
   - Template evaluation for dynamic data

3. **State Management**
   - Scoped state (window/workspace/global)
   - State watchers with automatic UI updates
   - Atomic state operations

4. **Lifecycle Management**
   - Window lifecycle events
   - Workspace reset/replay capabilities
   - Persistence and recovery

---

## 2. Problem Statement

### 2.1 Why Not DOM Manipulation?

**Technical Issues:**
- **Bypasses Security:** DOM manipulation circumvents `enforce_compute_policy` and permission gates
- **Fragile:** UI refactoring breaks agent code (CSS class changes, structure changes)
- **Performance:** DOM queries, event simulation, and state extraction are slow
- **Testing Pollution:** Mixes testing infrastructure with production agent APIs
- **State Inconsistency:** Agents see visual state, not source-of-truth application state

**Example Anti-Pattern:**
```typescript
// ❌ BAD: Agent uses Playwright
await page.click('#run-compute-button');
await page.waitForSelector('.result-panel');
const text = await page.textContent('.result-panel');
```

**Why This Fails:**
- If `.result-panel` class changes to `.output-panel`, agent breaks
- No policy enforcement on the compute action
- Race conditions between UI updates and agent reads
- Cannot access structured data (only HTML strings)

### 2.2 Desired State

**Agents should:**
1. Use typed, versioned APIs (not DOM selectors)
2. Go through security policy enforcement
3. Access structured data (not HTML scraping)
4. Operate at the command level (not UI level)
5. Be resilient to UI changes

**Example Correct Pattern:**
```typescript
// ✅ GOOD: Agent uses native API
await agentApi.compute.submit({
  task: 'analyze-data',
  input: { dataset: 'users.csv' },
  capabilities: { fsRead: true }
});
const result = await agentApi.compute.waitForResult(jobId);
```

---

## 3. Proposed Architecture

### 3.1 High-Level Design

```
┌─────────────────────────────────────────────────────────────┐
│                     Agent Layer                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Claude Agent │  │ Custom Agent │  │ Swarm Agent  │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│         │                  │                  │              │
│         └──────────────────┴──────────────────┘              │
└─────────────────────────────┬───────────────────────────────┘
                              │
                   ┌──────────▼──────────┐
                   │  Agent API Gateway  │
                   │  (agentBridge.ts)   │
                   └──────────┬──────────┘
                              │
         ┌────────────────────┼────────────────────┐
         │                    │                    │
┌────────▼────────┐  ┌────────▼────────┐  ┌───────▼────────┐
│  Command Queue  │  │  State Manager  │  │ Event Listener │
│  (enqueueBatch) │  │  (commitState)  │  │ (registerCmd)  │
└────────┬────────┘  └────────┬────────┘  └───────┬────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              │
                   ┌──────────▼──────────┐
                   │   Adapter System    │
                   │   (lifecycle.ts)    │
                   └──────────┬──────────┘
                              │
         ┌────────────────────┼────────────────────┐
         │                    │                    │
┌────────▼────────┐  ┌────────▼────────┐  ┌───────▼────────┐
│ Window Manager  │  │  Compute Engine │  │ Permission Gate│
└─────────────────┘  └─────────────────┘  └────────────────┘
```

### 3.2 Component Responsibilities

**1. Agent API Gateway (`agentBridge.ts`)**
- Expose typed APIs for agents
- Validate agent requests
- Transform agent calls to UICP batch operations
- Provide promise-based result handling
- Emit telemetry for agent actions

**2. Command Registry Extension**
- Register agent-specific command handlers
- Map agent intents to UICP operations
- Provide command versioning

**3. State Management Extension**
- Agent-scoped state namespace (`agent.*`)
- Read/write access to workspace state
- State change subscriptions for agents

**4. Event Bridge**
- Allow agents to subscribe to workspace events
- Filter events by agent scope
- Provide structured event payloads

### 3.3 Integration Points

**Existing System → Agent API:**
- `registerCommandHandler()` → `agentApi.registerCommand()`
- `enqueueBatch()` → `agentApi.executeBatch()`
- `commitStateValue()` → `agentApi.state.set()`
- `readStateValue()` → `agentApi.state.get()`
- `submitScriptComputeJob()` → `agentApi.compute.submit()`

**New Tauri Commands (Rust):**
```rust
// src-tauri/src/commands.rs additions
#[tauri::command]
pub async fn agent_execute_command(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    command: AgentCommand,
) -> Result<AgentCommandResult, String> { ... }

#[tauri::command]
pub async fn agent_subscribe_events(
    app: tauri::AppHandle<R>,
    filter: EventFilter,
) -> Result<(), String> { ... }
```

---

## 4. API Design

### 4.1 Agent API Surface

**File:** `uicp/src/lib/agent/agentBridge.ts` (NEW)

```typescript
/**
 * Agent Bridge API
 *
 * Provides type-safe, policy-enforced APIs for AI agents to interact
 * with UICP without direct DOM manipulation.
 */

export interface AgentAPI {
  // Window management
  window: {
    create(options: WindowCreateOptions): Promise<WindowHandle>;
    close(windowId: string): Promise<void>;
    update(windowId: string, updates: WindowUpdates): Promise<void>;
    list(): Promise<WindowInfo[]>;
  };

  // State management
  state: {
    set(scope: StateScope, key: string, value: unknown, options?: StateOptions): Promise<void>;
    get(scope: StateScope, key: string, options?: StateOptions): Promise<unknown>;
    patch(scope: StateScope, key: string, ops: PatchOperation[]): Promise<void>;
    watch(scope: StateScope, key: string, callback: StateWatchCallback): UnsubscribeFn;
  };

  // Compute operations
  compute: {
    submit(spec: ComputeJobSpec): Promise<JobHandle>;
    cancel(jobId: string): Promise<void>;
    waitForResult(jobId: string, timeout?: number): Promise<ComputeResult>;
    listJobs(): Promise<JobInfo[]>;
  };

  // Content rendering
  content: {
    render(windowId: string, target: string, html: string, options?: RenderOptions): Promise<void>;
    renderComponent(windowId: string, componentSpec: ComponentSpec): Promise<string>;
  };

  // Event subscriptions
  events: {
    on(eventType: AgentEventType, callback: EventCallback): UnsubscribeFn;
    emit(eventType: string, payload: unknown): Promise<void>;
  };

  // Clarification (user input prompts)
  clarify: {
    ask(question: ClarificationSpec): Promise<ClarificationResult>;
  };
}

export interface WindowCreateOptions {
  id?: string;
  title: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  resizable?: boolean;
  focusOnCreate?: boolean;
}

export interface WindowHandle {
  id: string;
  close(): Promise<void>;
  update(updates: WindowUpdates): Promise<void>;
  render(target: string, html: string): Promise<void>;
  onClose(callback: () => void): UnsubscribeFn;
}

export interface ComputeJobSpec {
  task: string;
  input: Record<string, unknown>;
  capabilities?: {
    fsRead?: string[];
    fsWrite?: string[];
    net?: string[];
    time?: boolean;
    random?: boolean;
  };
  timeoutMs?: number;
  cache?: 'readwrite' | 'readonly' | 'bypass';
  traceId?: string;
}

export interface JobHandle {
  jobId: string;
  cancel(): Promise<void>;
  wait(timeout?: number): Promise<ComputeResult>;
  onProgress(callback: (progress: JobProgress) => void): UnsubscribeFn;
}

export interface ComputeResult {
  ok: boolean;
  jobId: string;
  output?: unknown;
  error?: { code: string; message: string };
  metrics?: {
    durationMs: number;
    memoryMb: number;
    cacheHit?: boolean;
  };
}

export interface ClarificationSpec {
  question: string;
  fields: Array<{
    name: string;
    label: string;
    type: 'text' | 'textarea' | 'select';
    required?: boolean;
    options?: Array<{ label: string; value: string }>;
  }>;
  windowId?: string;
  title?: string;
}

export interface ClarificationResult {
  submitted: boolean;
  values: Record<string, string>;
}

export type AgentEventType =
  | 'compute.complete'
  | 'compute.error'
  | 'window.created'
  | 'window.closed'
  | 'state.changed'
  | 'ui.interaction';

export interface AgentEvent {
  type: AgentEventType;
  timestamp: number;
  payload: unknown;
  traceId?: string;
}
```

### 4.2 Implementation Patterns

**Pattern 1: Simple Window Creation**
```typescript
// Agent creates a new window and displays content
const window = await agentApi.window.create({
  title: 'Analysis Results',
  width: 800,
  height: 600
});

await window.render('#root', `
  <div class="p-4">
    <h1>Results</h1>
    <pre>${JSON.stringify(data, null, 2)}</pre>
  </div>
`);
```

**Pattern 2: Compute Job with Result Handling**
```typescript
// Agent submits a compute job and waits for result
const job = await agentApi.compute.submit({
  task: 'data-analysis.wasm',
  input: { dataset: 'sales-2024.csv', operation: 'summarize' },
  capabilities: { fsRead: ['ws:/files/**'] },
  timeoutMs: 30000
});

const result = await job.wait();
if (result.ok) {
  console.log('Analysis complete:', result.output);
} else {
  console.error('Job failed:', result.error);
}
```

**Pattern 3: State-Driven UI Updates**
```typescript
// Agent sets state and watches for changes
await agentApi.state.set('workspace', 'analysis.status', {
  progress: 0,
  message: 'Starting analysis...'
});

// UI automatically updates via existing state.watch
// No manual DOM manipulation needed

// Update progress
await agentApi.state.patch('workspace', 'analysis.status', [
  { op: 'set', path: 'progress', value: 50 },
  { op: 'set', path: 'message', value: 'Processing data...' }
]);
```

**Pattern 4: User Clarification**
```typescript
// Agent needs user input
const response = await agentApi.clarify.ask({
  question: 'Which data range should I analyze?',
  fields: [
    { name: 'start_date', label: 'Start Date', type: 'text' },
    { name: 'end_date', label: 'End Date', type: 'text' },
    { name: 'metric', label: 'Metric', type: 'select',
      options: [
        { label: 'Revenue', value: 'revenue' },
        { label: 'Users', value: 'users' }
      ]
    }
  ]
});

if (response.submitted) {
  // Continue with user's input
  const { start_date, end_date, metric } = response.values;
}
```

### 4.3 Error Handling

**Error Codes:**
```typescript
export enum AgentErrorCode {
  UNAUTHORIZED = 'Agent.Unauthorized',
  INVALID_REQUEST = 'Agent.InvalidRequest',
  POLICY_DENIED = 'Agent.PolicyDenied',
  TIMEOUT = 'Agent.Timeout',
  NOT_FOUND = 'Agent.NotFound',
  INTERNAL_ERROR = 'Agent.InternalError'
}

export class AgentError extends Error {
  constructor(
    public code: AgentErrorCode,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AgentError';
  }
}
```

**Usage:**
```typescript
try {
  await agentApi.compute.submit(spec);
} catch (error) {
  if (error instanceof AgentError) {
    switch (error.code) {
      case AgentErrorCode.POLICY_DENIED:
        console.error('Permission denied:', error.details);
        break;
      case AgentErrorCode.TIMEOUT:
        console.error('Job timed out after', error.details?.timeoutMs, 'ms');
        break;
      default:
        console.error('Unexpected error:', error.message);
    }
  }
}
```

### 4.4 Telemetry and Observability

**Every agent action should emit telemetry:**
```typescript
// Automatic telemetry in agentBridge.ts
function wrapWithTelemetry<T>(
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  const start = performance.now();
  const telemetry = createAdapterTelemetry({ traceId: generateTraceId() });

  return fn()
    .then(result => {
      telemetry.event('agent.operation.success', {
        operation,
        durationMs: performance.now() - start
      });
      return result;
    })
    .catch(error => {
      telemetry.error('agent.operation.error', error, {
        operation,
        durationMs: performance.now() - start
      });
      throw error;
    });
}
```

**Metrics to Track:**
- Agent operation counts by type
- Success/failure rates
- Execution latency (p50, p95, p99)
- Policy denial frequency
- State mutation counts

---

## 5. Implementation Phases

### Phase 1: Foundation (Weeks 1-2)

**Goal:** Create agent API infrastructure without breaking existing code.

**Tasks:**
1. **Create Agent Bridge Module**
   - [ ] Create `uicp/src/lib/agent/agentBridge.ts`
   - [ ] Define TypeScript interfaces (AgentAPI, WindowHandle, JobHandle, etc.)
   - [ ] Implement basic window operations (create, close, update)
   - [ ] Add telemetry hooks

2. **Extend Command Registry**
   - [ ] Add `agent.*` command namespace
   - [ ] Register `agent.window.create`, `agent.window.close` handlers
   - [ ] Add command versioning support

3. **Add Rust Tauri Commands**
   - [ ] Add `agent_execute_command` in `src-tauri/src/commands.rs`
   - [ ] Add agent command validation
   - [ ] Wire up to existing AppState

4. **Testing Infrastructure**
   - [ ] Unit tests for agentBridge.ts
   - [ ] Integration tests for window operations
   - [ ] Mock agent scenarios

**Deliverables:**
- Working agent API for window management
- Test suite with >80% coverage
- Documentation for basic agent operations

**Success Criteria:**
- Agent can create and close windows programmatically
- No regressions in existing UI functionality
- All tests passing

### Phase 2: State and Compute Integration (Weeks 3-4)

**Goal:** Enable agents to interact with state and submit compute jobs.

**Tasks:**
1. **State Management API**
   - [ ] Implement `agentApi.state.set/get/patch`
   - [ ] Add state watchers for agents
   - [ ] Create agent-scoped state namespace

2. **Compute Integration**
   - [ ] Implement `agentApi.compute.submit`
   - [ ] Add job handle with cancel/wait methods
   - [ ] Wire to existing `submitScriptComputeJob`

3. **Event Subscriptions**
   - [ ] Implement `agentApi.events.on`
   - [ ] Add event filtering by agent scope
   - [ ] Emit compute lifecycle events

4. **Policy Enforcement Verification**
   - [ ] Ensure all agent operations go through `enforce_compute_policy`
   - [ ] Add policy tests for agent operations
   - [ ] Verify capability checks work correctly

**Deliverables:**
- Full compute API for agents
- State management with proper scoping
- Event subscription system

**Success Criteria:**
- Agents can submit compute jobs and receive results
- State changes from agents trigger UI updates
- Policy denials are properly enforced

### Phase 3: Content Rendering and Clarification (Weeks 5-6)

**Goal:** Enable rich content rendering and user interaction.

**Tasks:**
1. **Content Rendering**
   - [ ] Implement `agentApi.content.render`
   - [ ] Add component rendering support
   - [ ] Sanitization and security checks

2. **Clarification API**
   - [ ] Implement `agentApi.clarify.ask`
   - [ ] Wire to existing `renderStructuredClarifier`
   - [ ] Add timeout handling

3. **Advanced Window Features**
   - [ ] Window positioning and sizing
   - [ ] Z-index management
   - [ ] Window lifecycle listeners

**Deliverables:**
- Rich content rendering for agents
- User clarification system
- Complete window management API

**Success Criteria:**
- Agents can display formatted content
- Agents can ask users for input
- UI updates are smooth and glitch-free

### Phase 4: Multi-Agent Orchestration (Weeks 7-8)

**Goal:** Enable multiple agents to work together via ruv-swarm.

**Tasks:**
1. **Agent Coordination**
   - [ ] Add agent ID tracking
   - [ ] Implement agent-to-agent messaging
   - [ ] Add shared state coordination

2. **Ruv-Swarm Integration**
   - [ ] Map ruv-swarm MCP tools to agent API
   - [ ] Add swarm orchestration commands
   - [ ] Implement task distribution

3. **Agent Lifecycle Management**
   - [ ] Agent spawn/terminate
   - [ ] Health checks
   - [ ] Resource cleanup

4. **Conflict Resolution**
   - [ ] Handle concurrent state mutations
   - [ ] Window ownership policies
   - [ ] Compute resource fairness

**Deliverables:**
- Multi-agent coordination system
- Ruv-swarm MCP integration
- Agent lifecycle management

**Success Criteria:**
- Multiple agents can work on separate tasks simultaneously
- No race conditions or deadlocks
- Resource limits respected

### Phase 5: Production Hardening (Weeks 9-10)

**Goal:** Make the system production-ready.

**Tasks:**
1. **Performance Optimization**
   - [ ] Profile critical paths
   - [ ] Optimize batch operations
   - [ ] Add caching where appropriate

2. **Error Recovery**
   - [ ] Implement retry logic
   - [ ] Add circuit breakers
   - [ ] Handle partial failures gracefully

3. **Monitoring and Alerting**
   - [ ] Add structured logging
   - [ ] Implement metrics dashboard
   - [ ] Set up alerting rules

4. **Documentation**
   - [ ] API reference documentation
   - [ ] Agent development guide
   - [ ] Example agent implementations
   - [ ] Troubleshooting guide

**Deliverables:**
- Production-ready agent system
- Complete documentation
- Monitoring dashboards

**Success Criteria:**
- System handles 100 concurrent agent operations
- P99 latency <500ms for agent API calls
- <0.1% error rate

### Phase 6: Playwright Testing Integration (Weeks 11-12)

**Goal:** Use Playwright for UI testing, NOT agent interaction.

**Tasks:**
1. **Test Suite Development**
   - [ ] End-to-end UI tests
   - [ ] Visual regression tests
   - [ ] Accessibility tests

2. **CI/CD Integration**
   - [ ] Add Playwright to CI pipeline
   - [ ] Screenshot comparisons
   - [ ] Test report generation

3. **Test Helpers**
   - [ ] Create test fixtures
   - [ ] Page object models
   - [ ] Custom assertions

**Deliverables:**
- Comprehensive UI test suite
- CI/CD integration
- Test maintenance guide

**Success Criteria:**
- >90% UI coverage
- Tests run in <5 minutes
- No flaky tests

---

## 6. Security Model

### 6.1 Threat Model

**Threats to Mitigate:**
1. **Malicious Agent Code**
   - Agent attempts to read sensitive files
   - Agent tries to make unauthorized network requests
   - Agent bypasses policy enforcement
   - **Mitigation:** Use existing `enforce_compute_policy` and capability checks

2. **Resource Exhaustion**
   - Agent creates excessive windows or jobs
   - Agent consumes too much memory/CPU
   - Agent causes performance degradation for users
   - **Mitigation:** Resource limits and monitoring (not artificial operation caps)

3. **Privilege Escalation**
   - Agent requests escalated capabilities beyond what user authorized
   - **Mitigation:** Leverage existing permission prompt system

### 6.2 Security Boundaries

**Philosophy:** Leverage existing UICP security systems instead of creating new restrictive layers.

**Agent Context:**
```typescript
// Each agent gets a unique ID for telemetry and coordination
export interface AgentContext {
  agentId: string;
  traceId: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

// Context used for tracking, not artificial restrictions
await agentApi.compute.submit(spec, { agentId: 'agent-123' });
```

**Use Existing Policy Enforcement:**
```rust
// src-tauri/src/commands.rs
pub async fn agent_execute_command(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    command: AgentCommand,
) -> Result<AgentCommandResult, String> {
    // Agents use the SAME policy enforcement as UI operations
    if let Some(deny) = enforce_compute_policy(&command.spec) {
        return Err(format!("Policy denied: {}", deny));
    }

    // Same capability checks apply
    // Same permission prompts appear to user if needed

    execute_command(app, state, command).await
}
```

**Flexible State Access:**
```typescript
// Agents use existing state scopes (window/workspace/global)
// No artificial namespace restrictions

// ✅ Agent can read user preferences to personalize responses
const theme = await agentApi.state.get('workspace', 'user.preferences.theme');

// ✅ Agent can access shared workspace data
const dataset = await agentApi.state.get('workspace', 'datasets.current');

// ✅ Agent can write to shared state for collaboration
await agentApi.state.set('workspace', 'analysis.results', data);

// ✅ Agent can use descriptive namespaces by convention (not enforcement)
await agentApi.state.set('workspace', 'agent.analyzer.status', 'running');

// Existing permission system handles sensitive operations
// User gets prompted for file access, network calls, etc.
```

### 6.3 Audit Logging

**All agent actions must be logged:**
```typescript
export interface AgentAuditLog {
  timestamp: number;
  agentId: string;
  operation: string;
  params: Record<string, unknown>;
  result: 'success' | 'failure' | 'denied';
  durationMs: number;
  errorCode?: string;
}

// Automatically logged in agentBridge.ts
function logAgentAction(log: AgentAuditLog): void {
  // Write to Tauri backend for persistent storage
  invoke('agent_audit_log', { log });
}
```

### 6.4 Resource Management

**Goal:** Prevent runaway agents from degrading user experience, not artificially limit legitimate use.

**Approach:** Use existing compute system's resource management:

```typescript
// Agents respect existing concurrency limits
// (Already implemented in UICP compute system)

// Example: Compute job with resource limits
await agentApi.compute.submit({
  task: 'data-analysis',
  input: data,
  timeoutMs: 30000,           // Existing timeout mechanism
  memLimitMb: 512,            // Existing memory limit
  capabilities: {             // Existing capability system
    fsRead: ['ws:/files/**']
  }
});

// Existing queue system handles concurrency
// No need for artificial "operations per second" limits
```

**Optional Monitoring (Not Enforcement):**
```typescript
// Track metrics for observability, not hard limits
interface AgentMetrics {
  windowsCreated: number;
  activeJobs: number;
  stateUpdates: number;
  errorRate: number;
}

// Alert on unusual patterns, don't block legitimate use
// Example: Alert if agent creates 1000+ windows (likely a bug)
// Don't block an agent generating a 200-point dashboard
```

**Key Principle:** Trust agents to do their job. Monitor for abuse, don't prevent legitimate work.

---

## 7. Testing Strategy

### 7.1 Unit Tests

**Target:** Individual agent API methods

**Location:** `uicp/src/lib/agent/__tests__/`

**Example:**
```typescript
describe('AgentAPI.window', () => {
  let agentApi: AgentAPI;

  beforeEach(() => {
    agentApi = createAgentAPI({ agentId: 'test-agent' });
  });

  it('should create window with correct properties', async () => {
    const window = await agentApi.window.create({
      title: 'Test Window',
      width: 800,
      height: 600
    });

    expect(window.id).toBeDefined();
    expect(window.id).toMatch(/^window-/);
  });

  it('should throw error if agent lacks permission', async () => {
    const restrictedApi = createAgentAPI({
      agentId: 'restricted',
      capabilities: { window: false }
    });

    await expect(
      restrictedApi.window.create({ title: 'Test' })
    ).rejects.toThrow(AgentError);
  });
});
```

### 7.2 Integration Tests

**Target:** Agent API + Adapter system interaction

**Location:** `uicp/src/lib/agent/__tests__/integration/`

**Example:**
```typescript
describe('Agent Compute Integration', () => {
  it('should submit job and receive result', async () => {
    const agentApi = createAgentAPI({ agentId: 'test-agent' });

    const job = await agentApi.compute.submit({
      task: 'echo.wasm',
      input: { message: 'Hello, World!' },
      capabilities: {},
      timeoutMs: 5000
    });

    const result = await job.wait();

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ message: 'Hello, World!' });
    expect(result.metrics?.cacheHit).toBeDefined();
  });

  it('should enforce policy on unauthorized capabilities', async () => {
    const agentApi = createAgentAPI({ agentId: 'test-agent' });

    await expect(
      agentApi.compute.submit({
        task: 'file-reader.wasm',
        input: {},
        capabilities: { fsRead: ['/etc/passwd'] } // Unauthorized path
      })
    ).rejects.toThrow(AgentError);
  });
});
```

### 7.3 End-to-End Tests (Playwright)

**Target:** Full user workflows including agent interactions

**Location:** `uicp/e2e/agent-workflows.spec.ts`

**Example:**
```typescript
test('agent creates analysis window and displays results', async ({ page }) => {
  // Navigate to app
  await page.goto('http://localhost:1420');

  // Start agent via UI button
  await page.click('[data-testid="start-analysis-agent"]');

  // Wait for agent to create window
  await page.waitForSelector('[data-window-id^="agent-analysis-"]');

  // Verify content
  const window = page.locator('[data-window-id^="agent-analysis-"]');
  await expect(window).toContainText('Analysis Complete');

  // Verify structured data is displayed
  await expect(window.locator('.results-table')).toBeVisible();
});
```

### 7.4 Performance Tests

**Target:** Latency, throughput, resource usage

**Location:** `uicp/src/lib/agent/__tests__/performance/`

**Example:**
```typescript
describe('Agent API Performance', () => {
  it('should handle 100 concurrent window operations', async () => {
    const agentApi = createAgentAPI({ agentId: 'perf-test' });
    const start = performance.now();

    const promises = Array.from({ length: 100 }, (_, i) =>
      agentApi.window.create({ title: `Window ${i}` })
    );

    const windows = await Promise.all(promises);
    const duration = performance.now() - start;

    expect(windows).toHaveLength(100);
    expect(duration).toBeLessThan(5000); // Complete in <5s
  });

  it('should not leak memory after 1000 operations', async () => {
    const agentApi = createAgentAPI({ agentId: 'memory-test' });
    const initialMemory = performance.memory.usedJSHeapSize;

    for (let i = 0; i < 1000; i++) {
      const window = await agentApi.window.create({ title: `Win ${i}` });
      await window.close();
    }

    // Force GC if available
    if (global.gc) global.gc();

    const finalMemory = performance.memory.usedJSHeapSize;
    const leak = finalMemory - initialMemory;

    expect(leak).toBeLessThan(10 * 1024 * 1024); // <10MB leak
  });
});
```

### 7.5 Security Tests

**Target:** Verify agents use existing security systems correctly

**Location:** `uicp/src/lib/agent/__tests__/security/`

**Example:**
```typescript
describe('Agent Security', () => {
  it('should enforce existing compute policy', async () => {
    const agentApi = createAgentAPI({ agentId: 'test-agent' });

    // Attempt unauthorized file access
    await expect(
      agentApi.compute.submit({
        task: 'file-reader.wasm',
        input: { path: '/etc/passwd' },
        capabilities: { fsRead: ['/etc/passwd'] }
      })
    ).rejects.toThrow('Policy denied');

    // Existing policy enforcement works for agents
  });

  it('should allow agents to collaborate via shared state', async () => {
    const agent1 = createAgentAPI({ agentId: 'agent-1' });
    const agent2 = createAgentAPI({ agentId: 'agent-2' });

    // Agent 1 writes results
    await agent1.state.set('workspace', 'shared.analysis', { status: 'complete' });

    // Agent 2 can read those results (collaboration enabled)
    const result = await agent2.state.get('workspace', 'shared.analysis');

    expect(result).toEqual({ status: 'complete' });
  });

  it('should trigger user permission prompts for sensitive operations', async () => {
    const agentApi = createAgentAPI({ agentId: 'test-agent' });

    // Sensitive operation should trigger existing permission system
    // (mock or integration test with permission dialog)
    const spy = jest.spyOn(window, 'showPermissionPrompt');

    await agentApi.compute.submit({
      task: 'network-fetch.wasm',
      capabilities: { net: ['https://api.example.com'] }
    });

    expect(spy).toHaveBeenCalled(); // User gets prompted
  });
});
```

---

## 8. Migration Path

### 8.1 Backward Compatibility

**Principle:** Existing code continues to work during migration.

**Strategy:**
1. Agent API is **additive** - no breaking changes to adapter system
2. Existing command handlers remain functional
3. New agent commands coexist with existing UI commands

**Example:**
```typescript
// OLD: Direct batch operations (still works)
await applyBatch([
  { op: 'window.create', params: { id: 'my-window', title: 'Title' } }
]);

// NEW: Agent API (works alongside old code)
await agentApi.window.create({ title: 'Title' });
```

### 8.2 Deprecation Timeline

**Phase 1 (Weeks 1-6):** Introduction
- Agent API is marked `@beta`
- Documentation encourages adoption but doesn't require it
- Existing patterns continue to work

**Phase 2 (Weeks 7-12):** Stabilization
- Agent API graduates to `@stable`
- Documentation updated to show agent API as primary pattern
- Examples migrated to agent API

**Phase 3 (Weeks 13+):** Consolidation
- Direct batch operations marked `@deprecated` for agent use cases
- Linting rules discourage direct batch usage in agent code
- Migration guide provided

**NO BREAKING CHANGES:** Direct batch operations remain supported for UI code indefinitely.

### 8.3 Migration Checklist

**For each agent implementation:**
- [ ] Identify current interaction pattern (DOM, batch ops, etc.)
- [ ] Map to equivalent agent API calls
- [ ] Add error handling
- [ ] Add telemetry
- [ ] Test in isolation
- [ ] Test with multi-agent scenarios
- [ ] Update documentation
- [ ] Deploy and monitor

---

## 9. Risk Mitigation

### 9.1 Identified Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Performance regression** | Medium | High | Benchmark before/after each phase; optimize critical paths |
| **Agent API complexity** | Medium | Medium | Start simple; expand based on real use cases |
| **Breaking existing code** | Low | High | Comprehensive test coverage; careful code review |
| **Security vulnerabilities** | Medium | Critical | Security review at each phase; penetration testing |
| **Incomplete migration** | High | Medium | Clear documentation; automated linting |
| **Multi-agent conflicts** | Medium | Medium | State scoping; resource limits; conflict detection |

### 9.2 Rollback Plan

**If critical issues emerge:**

1. **Immediate:** Feature flag to disable agent API
   ```typescript
   if (!ENV.AGENT_API_ENABLED) {
     throw new Error('Agent API disabled');
   }
   ```

2. **Short-term:** Revert last deployment
   - Git tag for each phase deployment
   - Database migrations are reversible
   - No data loss

3. **Long-term:** Isolate problematic features
   - Disable specific agent operations (e.g., compute only)
   - Keep working features enabled
   - Fix issues incrementally

### 9.3 Monitoring and Alerts

**Key Metrics:**
- Agent API error rate (alert if >1%)
- Agent operation latency (alert if p99 >2s)
- Policy denial rate (alert if spike >50% increase)
- Memory usage per agent (alert if >500MB)
- Concurrent agent count (alert if >100)

**Alert Channels:**
- Slack #agent-alerts
- PagerDuty for critical issues
- Email for non-urgent warnings

---

## 10. Success Metrics

### 10.1 Performance Metrics

**Baseline (Pre-Implementation):**
- No formal agent API exists
- DOM manipulation would be estimated at 200-500ms per operation
- No agent-specific telemetry

**Target (Post-Implementation):**
- Agent API call latency: p50 <50ms, p95 <200ms, p99 <500ms
- Throughput: 100+ concurrent agent operations
- Memory: <100MB per agent instance
- 40-60% faster than DOM manipulation approach

### 10.2 Reliability Metrics

**Targets:**
- Agent API uptime: 99.9%
- Error rate: <0.1% (excluding policy denials)
- Policy enforcement: 100% of operations
- Zero security incidents

### 10.3 Developer Experience Metrics

**Targets:**
- Time to build first agent: <2 hours (with docs)
- API comprehension: >80% of developers understand API within 1 week
- Documentation quality: >4.5/5 rating
- Bug report rate: <5 per month

### 10.4 Business Impact

**Targets:**
- Enable 3+ production agent use cases
- Reduce manual task time by 30%+
- Support 50+ concurrent agent sessions
- Zero downtime during rollout

---

## 11. References

### 11.1 Internal Documentation

- UICP Adapter Architecture: `uicp/src/lib/uicp/adapters/README.md` (to be created)
- Compute System Design: `uicp/src-tauri/docs/compute.md` (to be created)
- Security Policy Guide: `docs/security-policy.md` (to be created)

### 11.2 Related Technologies

- **Tauri:** https://tauri.app/
- **Ruv-Swarm MCP:** https://github.com/ruvnet/ruv-FANN/blob/main/ruv-swarm/docs/MCP_USAGE.md
- **Playwright (testing):** https://playwright.dev/
- **WebAssembly Component Model:** https://component-model.bytecodealliance.org/

### 11.3 Code Locations

**Key Files:**
- Agent Bridge (NEW): `uicp/src/lib/agent/agentBridge.ts`
- Adapter Events: `uicp/src/lib/uicp/adapters/adapter.events.ts`
- Lifecycle: `uicp/src/lib/uicp/adapters/lifecycle.ts`
- Tauri Commands: `uicp/src-tauri/src/commands.rs`
- Compute Engine: `uicp/src-tauri/src/compute.rs`

**Test Locations:**
- Unit: `uicp/src/lib/agent/__tests__/`
- Integration: `uicp/src/lib/agent/__tests__/integration/`
- E2E: `uicp/e2e/`
- Performance: `uicp/src/lib/agent/__tests__/performance/`

---

## Appendix A: Example Agent Implementation

**File:** `uicp/examples/agents/data-analyzer.ts`

```typescript
import { createAgentAPI } from '@/lib/agent/agentBridge';

/**
 * Example Agent: Data Analyzer
 *
 * This agent analyzes CSV data and displays results in a window.
 */

export class DataAnalyzerAgent {
  private api: AgentAPI;
  private window?: WindowHandle;

  constructor() {
    this.api = createAgentAPI({ agentId: 'data-analyzer' });
  }

  async analyze(dataset: string): Promise<void> {
    try {
      // Create window for results
      this.window = await this.api.window.create({
        title: 'Data Analysis Results',
        width: 900,
        height: 700
      });

      // Show loading state
      await this.window.render('#root', `
        <div class="p-4">
          <h1 class="text-xl font-bold">Analyzing ${dataset}...</h1>
          <div class="mt-4">
            <div class="animate-spin h-8 w-8 border-4 border-blue-500"></div>
          </div>
        </div>
      `);

      // Submit compute job
      const job = await this.api.compute.submit({
        task: 'csv-analyzer.wasm',
        input: { dataset, operations: ['summary', 'outliers'] },
        capabilities: {
          fsRead: [`ws:/files/${dataset}`]
        },
        timeoutMs: 30000
      });

      // Wait for result
      const result = await job.wait();

      if (!result.ok) {
        throw new Error(result.error?.message || 'Analysis failed');
      }

      // Display results
      await this.displayResults(result.output);

    } catch (error) {
      await this.displayError(error);
    }
  }

  private async displayResults(data: unknown): Promise<void> {
    const html = this.formatResults(data);
    await this.window?.render('#root', html);
  }

  private async displayError(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.window?.render('#root', `
      <div class="p-4">
        <h1 class="text-xl font-bold text-red-600">Analysis Error</h1>
        <p class="mt-2 text-gray-700">${message}</p>
      </div>
    `);
  }

  private formatResults(data: unknown): string {
    // Format data as HTML table
    // Implementation details...
    return '<div>Results...</div>';
  }

  async close(): Promise<void> {
    if (this.window) {
      await this.window.close();
    }
  }
}

// Usage:
const agent = new DataAnalyzerAgent();
await agent.analyze('sales-2024.csv');
```

---

## Appendix B: Comparison Matrix

| Feature | DOM Manipulation (Playwright) | Native Agent API |
|---------|-------------------------------|-------------------|
| **Security** | ❌ Bypasses policy | ✅ Full policy enforcement |
| **Performance** | ⚠️ Slow (200-500ms/op) | ✅ Fast (50-200ms/op) |
| **Reliability** | ❌ Brittle (breaks on UI changes) | ✅ Stable (API contract) |
| **Data Access** | ❌ HTML scraping | ✅ Structured data |
| **Type Safety** | ❌ String selectors | ✅ TypeScript types |
| **Testing** | ✅ Good for E2E UI tests | ⚠️ Not for UI testing |
| **Multi-Agent** | ❌ Race conditions | ✅ Proper coordination |
| **Observability** | ⚠️ Limited | ✅ Full telemetry |
| **Learning Curve** | ⚠️ Moderate | ✅ Simple |
| **Purpose** | UI Testing | Agent Interaction |

---

## Appendix C: FAQ

**Q: Can agents still read DOM for context?**
A: Agents should not rely on DOM parsing. Instead, use state APIs to read structured data. If visual context is needed, use snapshot APIs (to be implemented).

**Q: How do agents handle long-running tasks?**
A: Use the compute API with job handles. Agents can cancel jobs, poll for progress, or subscribe to events.

**Q: Can multiple agents share a window?**
A: Yes! Windows are workspace resources. Multiple agents can read from and write to the same window. Coordinate via shared state to avoid conflicts. Example: One agent creates a dashboard window, another agent updates specific panels.

**Q: What happens if an agent crashes?**
A: Agent context is cleaned up automatically. Windows are closed, jobs are cancelled, and state is reset. Audit log preserved.

**Q: How do agents authenticate?**
A: Agents are created with an AgentContext that includes capabilities. The creating user's permissions apply to the agent.

**Q: Can agents call external APIs?**
A: Yes, through the compute system with `net` capability. Network requests are subject to policy enforcement.

**Q: How do I debug agent behavior?**
A: Use telemetry dashboard, audit logs, and trace IDs. Enable debug mode to see all agent operations in console.

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2025-10-29 | Planning Team | Initial draft |
| 1.1 | 2025-10-29 | Planning Team | Removed overly-restrictive security patterns; leverage existing UICP security |

---

## Approval Signatures

_To be filled in during review process_

- [ ] **Technical Lead:** _______________
- [ ] **Security Review:** _______________
- [ ] **Product Owner:** _______________
- [ ] **Engineering Manager:** _______________

---

**End of Document**
