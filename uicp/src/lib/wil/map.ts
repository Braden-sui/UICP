import { operationSchemas, type OperationNameT } from "../uicp/schemas";

// WHY: `toOp` is a lightweight mapper from parsed slots to validated params.
// We keep runtime validation strict (Zod parse), but avoid exposing a wide
// discriminated-union type for `params` here because tests (and some call sites)
// access fields like `height` without control-flow narrowing.
// INVARIANT: Never silently swallow validation; Zod must parse successfully.
// SAFETY: Return `Record<string, unknown>` to allow read access without
// over-constraining the type; later envelope validation enforces exact shapes.
export function toOp<K extends OperationNameT>(parsed: { op: K; slots: unknown }): {
  op: K;
  params: Record<string, unknown>;
} {
  const schema = operationSchemas[parsed.op];
  const validated = schema.parse(coerceFor(parsed.op, parsed.slots));
  return { op: parsed.op, params: validated as Record<string, unknown> };
}

function coerceFor(op: OperationNameT, slots: unknown): Record<string, unknown> {
  const s = (slots ?? {}) as Record<string, unknown>;
  // Light coercions only; the Zod schema remains the final guard.
  switch (op) {
    case "window.create":
    case "window.update": {
      // Defense-in-depth: if size is a dimension string like "1200x800", split it.
      // This complements postProcess in parse.ts and catches edge cases.
      let result = { ...s };
      if (typeof result.size === 'string') {
        const match = /^(\d+)\s*x\s*(\d+)$/i.exec(result.size);
        if (match) {
          result.width = Number(match[1]);
          result.height = Number(match[2]);
          delete result.size; // Remove to avoid schema clash with enum values
        }
      }
      return {
        ...result,
        width: clampDimension(coerceNumber(result.width)),
        height: clampDimension(coerceNumber(result.height)),
        x: coerceNumber(result.x),
        y: coerceNumber(result.y),
        zIndex: coerceNumber(result.zIndex),
      };
    }
    case "dom.set":
    case "dom.replace":
    case "dom.append": {
      return { ...s, sanitize: coerceBoolean(s.sanitize) };
    }
    case "api.call": {
      const method = typeof s.method === "string" ? s.method.toUpperCase() : undefined;
      return { ...s, method };
    }
    default:
      return s;
  }
}

function coerceNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().length) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Clamp dimension (width/height) to schema minimum of 120px.
 * Prevents Zod validation failures when agents suggest small dimensions.
 */
function clampDimension(n: number | undefined): number | undefined {
  return typeof n === 'number' ? Math.max(120, n) : undefined;
}

function coerceBoolean(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "true") return true;
    if (t === "false") return false;
  }
  return undefined;
}
