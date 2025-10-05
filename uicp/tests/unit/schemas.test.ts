// Schema tests guarantee planner output is validated before reaching the adapter.
import type { Envelope } from "../../src/lib/uicp/schemas";
import { describe, it, expect } from "vitest";
import { validateBatch, UICPValidationError, validatePlan } from "../../src/lib/uicp/schemas";

describe("UICP schema validation", () => {
  it("accepts a valid window.create command", () => {
    const batch = validateBatch([
      {
        op: "window.create",
        params: { title: "Test", x: 10, y: 10, width: 400, height: 300 },
      },
    ]);
    const first = batch[0] as Envelope<"window.create">;
    expect(first.params.title).toBe("Test");
  });

  it("throws with pointer when params are invalid", () => {
    expect(() =>
      validateBatch([
        {
          op: "dom.set",
          params: { windowId: "", target: "#root", html: "<p>oops</p>" },
        },
      ]),
    ).toThrow(UICPValidationError);

    try {
      validateBatch([
        {
          op: "dom.set",
          params: { windowId: "", target: "#root", html: "<p>oops</p>" },
        },
      ]);
    } catch (error) {
      expect(error).toBeInstanceOf(UICPValidationError);
      const validationError = error as UICPValidationError;
      expect(validationError.pointer).toContain("/0/params/windowId");
    }
  });
});

describe("UICP plan validation", () => {
  it("accepts a valid plan and normalises batch", () => {
    const plan = validatePlan({
      summary: "Create window and inject HTML",
      risks: "low",
      batch: [
        { type: "command", op: "window.create", params: { id: "win-1", title: "Plan Test" } },
        { type: "command", op: "dom.set", params: { windowId: "win-1", target: "#root", html: "<p>ok</p>" } },
      ],
    });

    expect(plan.summary).toBe("Create window and inject HTML");
    expect(Array.isArray(plan.risks)).toBe(true);
    expect(plan.batch.length).toBe(2);
    expect(plan.batch[0].op).toBe("window.create");
  });

  it("rejects malformed plan without summary", () => {
    expect(() =>
      validatePlan({
        batch: [
          { type: "command", op: "window.create", params: { id: "win-1", title: "No Summary" } },
        ],
      } as unknown),
    ).toThrow(UICPValidationError);
  });

  it("accepts snake_case entries and maps keys", () => {
    const plan = validatePlan({
      summary: "Snake case batch",
      batch: [
        {
          type: "command",
          op: "window.create",
          params: { title: "Snake" },
          idempotency_key: "abc",
          txn_id: "txn-1",
          window_id: "win-x",
        },
      ],
    });
    expect(plan.batch[0].idempotencyKey).toBe("abc");
    // windowId may be mirrored from params later; here we only ensure parsing does not throw.
    expect(plan.batch[0].op).toBe("window.create");
  });

  it("rejects unsafe HTML in plan batch with helpful pointer", () => {
    try {
      validatePlan({
        summary: "Unsafe HTML",
        batch: [
          { type: "command", op: "window.create", params: { id: "w1", title: "Test" } },
          {
            type: "command",
            op: "dom.set",
            params: { windowId: "w1", target: "#root", html: '<div onclick="alert(1)">x</div>' },
          },
        ],
      });
      expect.unreachable("Expected validation error");
    } catch (error) {
      expect(error).toBeInstanceOf(UICPValidationError);
      const e = error as UICPValidationError;
      expect(e.pointer).toContain("/batch/");
      expect(e.pointer).toContain("/params/html");
    }
  });

  it("rejects <style> tags in HTML payloads", () => {
    expect(() =>
      validatePlan({
        summary: "Style tag should be rejected",
        batch: [
          { type: "command", op: "window.create", params: { id: "w2", title: "Test" } },
          {
            type: "command",
            op: "dom.set",
            params: { windowId: "w2", target: "#root", html: '<style>.x{color:red}</style><div>x</div>' },
          },
        ],
      }),
    ).toThrow(UICPValidationError);
  });
});
