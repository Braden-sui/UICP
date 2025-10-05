// Schema tests guarantee planner output is validated before reaching the adapter.
import type { Envelope } from "../../src/lib/uicp/schemas";
import { describe, it, expect } from "vitest";
import { validateBatch, UICPValidationError } from "../../src/lib/uicp/schemas";

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
          op: "dom.replace",
          params: { windowId: "", target: "#root", html: "<p>oops</p>" },
        },
      ]),
    ).toThrow(UICPValidationError);

    try {
      validateBatch([
        {
          op: "dom.replace",
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
