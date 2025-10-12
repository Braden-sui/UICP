import { operationSchemas, type OperationNameT } from "../uicp/schemas";

export function toOp<K extends OperationNameT>(parsed: { op: K; slots: unknown }) {
  const schema = operationSchemas[parsed.op];
  const validated = schema.parse(coerceFor(parsed.op, parsed.slots));
  return { op: parsed.op, params: validated } as const;
}

function coerceFor(op: OperationNameT, slots: unknown): Record<string, unknown> {
  const s = (slots ?? {}) as Record<string, unknown>;
  // Light coercions only; the Zod schema remains the final guard.
  switch (op) {
    case "window.create":
    case "window.update": {
      return {
        ...s,
        width: coerceNumber(s.width),
        height: coerceNumber(s.height),
        x: coerceNumber(s.x),
        y: coerceNumber(s.y),
        zIndex: coerceNumber(s.zIndex),
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

function coerceBoolean(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "true") return true;
    if (t === "false") return false;
  }
  return undefined;
}

