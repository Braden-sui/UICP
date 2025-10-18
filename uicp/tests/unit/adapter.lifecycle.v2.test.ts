import { describe, it, expect, beforeEach, vi } from "vitest";
import { applyBatch, registerWorkspaceRoot, clearWorkspaceRoot } from "../../src/lib/uicp/adapters/lifecycle";

vi.mock("../../src/lib/uicp/adapters/windowManager", () => ({
  createWindowManager: vi.fn(() => ({
    create: vi.fn(async (p: any) => ({ windowId: p.id, applied: true })),
    move: vi.fn(async () => ({ applied: true })),
    resize: vi.fn(async () => ({ applied: false })), // simulate idempotent no-op
    focus: vi.fn(async () => ({ applied: true })),
    close: vi.fn(async () => ({ applied: true })),
    exists: vi.fn(() => true),
  })),
}));

vi.mock("../../src/lib/uicp/adapters/domApplier", () => ({
  createDomApplier: vi.fn(() => ({
    apply: vi.fn(async () => ({ applied: 2, skippedDuplicates: 1 })),
  })),
}));

vi.mock("../../src/lib/uicp/adapters/componentRenderer", () => ({
  createComponentRenderer: vi.fn(() => ({
    render: vi.fn(async () => {}),
  })),
}));

const telemetryEvents: any[] = [];
vi.mock("../../src/lib/uicp/adapters/adapter.telemetry", () => ({
  AdapterEvents: {
    APPLY_START: 'adapter.apply.start',
    APPLY_END: 'adapter.apply.end',
    APPLY_ABORT: 'adapter.apply.abort',
    PERMISSION_DENIED: 'adapter.permission.denied',
    WINDOW_CREATE: 'adapter.window.create',
    WINDOW_CLOSE: 'adapter.window.close',
    DOM_APPLY: 'adapter.dom.apply',
    COMPONENT_RENDER: 'adapter.component.render',
    COMPONENT_UNKNOWN: 'adapter.component.unknown',
    VALIDATION_ERROR: 'adapter.validation.error',
  },
  createAdapterTelemetry: vi.fn(() => ({
    event: (name: string, fields?: any) => telemetryEvents.push({ name, fields }),
    error: (name: string, err: any, fields?: any) => telemetryEvents.push({ name, error: String(err), fields }),
    time: vi.fn(async (_name: string, fn: () => Promise<any>) => await fn()),
    startTimer: vi.fn(() => () => 0),
  })),
}));

let permissionGateMock = { require: vi.fn(async () => "granted"), isGated: vi.fn(() => false) };
vi.mock("../../src/lib/uicp/adapters/permissionGate", () => ({
  createPermissionGate: vi.fn(() => permissionGateMock),
}));

// Accept any envelope shape the current schema expects
let validateEnvelopeMock = vi.fn((e: any) => e);
vi.mock("../../src/lib/uicp/adapters/adapter.schema", () => ({
  get validateEnvelope() { return validateEnvelopeMock; },
}));

describe("adapter.lifecycle v2", () => {
  beforeEach(() => {
    telemetryEvents.length = 0;
    validateEnvelopeMock = vi.fn((e: any) => e); // Reset to default
    permissionGateMock = { require: vi.fn(async () => "granted"), isGated: vi.fn(() => false) }; // Reset to default
    clearWorkspaceRoot();
    const root = document.createElement("div");
    root.id = "workspace";
    registerWorkspaceRoot(root);
  });

  it("aborts cleanly if workspace root is missing", async () => {
    clearWorkspaceRoot();
    const res = await applyBatch([], { runId: "t1" } as any);
    expect(res.success).toBe(false);
    expect(res.deniedByPolicy).toBe(0);
    expect(telemetryEvents.some(e => e.name === 'adapter.apply.abort')).toBe(true);
    const abortEvent = telemetryEvents.find(e => e.name === 'adapter.apply.abort');
    expect(abortEvent?.fields?.reason).toBe('no_workspace_root');
  });

  it("applies ops and counts only real changes", async () => {
    const batch = [
      { id: "op1", op: "window.create", params: { id: "w1", title: "Window 1", x: 10, y: 10 } },
      { id: "op2", op: "window.resize", params: { id: "w1", width: 500, height: 400 } }, // mocked applied: false
      { id: "op3", op: "dom.set", params: { windowId: "w1", target: "#root", mode: "set", html: "<b>hi</b>" } },
      { id: "op4", op: "component.render", params: { windowId: "w1", type: "Box", props: {} } },
      { id: "op5", op: "window.close", params: { id: "w1" } },
    ];
    const res = await applyBatch(batch as any, { runId: "t2" } as any);
    // window.create applied: true (+1), resize applied: false (+0), dom.set adds +2, component.render: +1, window.close: +1
    expect(res.applied).toBe(1 + 0 + 2 + 1 + 1); // 5
    expect(res.skippedDuplicates).toBe(1);
    expect(res.deniedByPolicy).toBe(0);
    expect(res.success).toBe(true);
    expect(telemetryEvents.some(e => e.name === 'adapter.apply.start')).toBe(true);
    expect(telemetryEvents.some(e => e.name === 'adapter.apply.end')).toBe(true);
  });

  it("records permission denials and continues when allowPartial", async () => {
    permissionGateMock = {
      require: vi.fn(async () => "denied"),
      isGated: vi.fn(() => true),
    };

    const batch = [
      { id: "opD", op: "window.create", params: { id: "wX", title: "Test" } },
      { id: "opD2", op: "window.create", params: { id: "wY", title: "Test 2" } },
    ];
    const res = await applyBatch(batch as any, { allowPartial: true } as any);
    expect(res.deniedByPolicy).toBe(2);
    expect(res.applied).toBe(0);
    expect(res.success).toBe(false);
    expect(telemetryEvents.filter(e => e.name === 'adapter.permission.denied').length).toBe(2);
  });

  it("stops on first error when allowPartial is false", async () => {
    let callCount = 0;
    validateEnvelopeMock = vi.fn((e: any) => {
      callCount++;
      if (callCount === 1) throw new Error("bad shape");
      return e;
    });

    const batch = [
      { id: "opBad", op: "dom.set", params: {} },
      { id: "opGood", op: "window.create", params: { id: "w1", title: "Test" } },
    ];
    const res = await applyBatch(batch as any, { allowPartial: false } as any);
    expect(res.success).toBe(false);
    expect(res.errors[0]).toMatch(/bad shape/);
    expect(res.errors.length).toBe(1); // Stopped after first error
  });

  it("continues on errors when allowPartial is true", async () => {
    let callCount = 0;
    validateEnvelopeMock = vi.fn((e: any) => {
      callCount++;
      if (callCount === 1) throw new Error("bad shape");
      return e;
    });

    const batch = [
      { id: "opBad", op: "dom.set", params: {} },
      { id: "opGood", op: "window.create", params: { id: "w1", title: "Test" } },
    ];
    const res = await applyBatch(batch as any, { allowPartial: true } as any);
    expect(res.success).toBe(false);
    expect(res.errors.length).toBe(1); // Only first op failed
    expect(res.applied).toBeGreaterThan(0); // Second op succeeded
  });

  it("emits correct telemetry events for window operations", async () => {
    const batch = [
      { id: "op1", op: "window.create", params: { id: "w1", title: "Test" } },
      { id: "op2", op: "window.close", params: { id: "w1" } },
    ];
    await applyBatch(batch as any, { runId: "t3" } as any);
    
    expect(telemetryEvents.some(e => e.name === 'adapter.window.create')).toBe(true);
    expect(telemetryEvents.some(e => e.name === 'adapter.window.close')).toBe(true);
  });

  it("emits correct telemetry events for DOM operations", async () => {
    const batch = [
      { id: "op1", op: "window.create", params: { id: "w1", title: "Test" } },
      { id: "op2", op: "dom.set", params: { windowId: "w1", target: "#root", html: "<div>test</div>" } },
    ];
    await applyBatch(batch as any, { runId: "t4" } as any);
    
    const domApplyEvent = telemetryEvents.find(e => e.name === 'adapter.dom.apply');
    expect(domApplyEvent).toBeDefined();
    expect(domApplyEvent.fields.windowId).toBe("w1");
    expect(domApplyEvent.fields.applied).toBe(2);
    expect(domApplyEvent.fields.skipped).toBe(1);
  });

  it("emits correct telemetry events for component operations", async () => {
    const batch = [
      { id: "op1", op: "window.create", params: { id: "w1", title: "Test" } },
      { id: "op2", op: "component.render", params: { windowId: "w1", type: "Button", props: {} } },
    ];
    await applyBatch(batch as any, { runId: "t5" } as any);
    
    const componentEvent = telemetryEvents.find(e => e.name === 'adapter.component.render');
    expect(componentEvent).toBeDefined();
    expect(componentEvent.fields.windowId).toBe("w1");
    expect(componentEvent.fields.type).toBe("Button");
  });

  it("includes batchId in outcome", async () => {
    const batch = [
      { id: "op1", op: "window.create", params: { id: "w1", title: "Test" } },
    ];
    const res = await applyBatch(batch as any, { batchId: "custom-batch-123" } as any);
    
    expect(res.batchId).toBe("custom-batch-123");
  });

  it("generates batchId if not provided", async () => {
    const batch = [
      { id: "op1", op: "window.create", params: { id: "w1", title: "Test" } },
    ];
    const res = await applyBatch(batch as any, { runId: "t6" } as any);
    
    expect(res.batchId).toBeDefined();
    expect(res.batchId).toMatch(/^batch-/);
  });

  it("aggregates all outcome fields correctly", async () => {
    const batch = [
      { id: "op1", op: "window.create", params: { id: "w1", title: "Test" } },
      { id: "op2", op: "dom.set", params: { windowId: "w1", target: "#root", html: "<div>test</div>" } },
    ];
    const res = await applyBatch(batch as any, { runId: "t7", opsHash: "hash123" } as any);
    
    expect(res.applied).toBeGreaterThan(0);
    expect(res.skippedDuplicates).toBeGreaterThanOrEqual(0);
    expect(res.deniedByPolicy).toBe(0);
    expect(res.errors).toEqual([]);
    expect(res.success).toBe(true);
    expect(res.batchId).toBeDefined();
    expect(res.opsHash).toBe("hash123");
  });
});
