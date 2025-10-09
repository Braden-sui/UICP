import { z } from "zod";

// Error taxonomy for terminal results
export const computeErrorCode = z.enum([
  "Timeout",
  "Cancelled",
  "CapabilityDenied",
  "Input.Invalid",
  "Task.NotFound",
  "Runtime.Fault",
  "Resource.Limit",
  "IO.Denied",
  "Nondeterministic",
]);

export type ComputeErrorCode = z.infer<typeof computeErrorCode>;

export const bindSpecSchema = z.object({
  toStatePath: z.string().min(1),
});

export const capabilitiesSchema = z.object({
  fsRead: z.array(z.string()).optional(),
  fsWrite: z.array(z.string()).optional(),
  net: z.array(z.string()).optional(),
  // Policy flags for overrides
  longRun: z.boolean().optional(),
  memHigh: z.boolean().optional(),
});

export const jobSpecSchema = z.object({
  jobId: z.string().uuid(),
  task: z.string().min(1), // e.g. "csv.parse@1.2.0"
  input: z.unknown(),
  timeoutMs: z.number().int().positive().default(30_000),
  fuel: z.number().int().positive().optional(),
  memLimitMb: z.number().int().positive().optional(),
  bind: z.array(bindSpecSchema).default([]),
  cache: z.enum(["readwrite", "readOnly", "bypass"]).default("readwrite"),
  capabilities: capabilitiesSchema.default({}),
  replayable: z.boolean().default(true),
  // Workspace scoping for cache and bookkeeping on the host.
  workspaceId: z.string().min(1).default('default'),
  provenance: z.object({
    envHash: z.string().min(1),
    agentTraceId: z.string().optional(),
  }),
});

export type JobSpec = z.infer<typeof jobSpecSchema>;

// Partial event payload — content is task-specific, validated by the host before emission
export const partialEventSchema = z.object({
  jobId: z.string().uuid(),
  task: z.string(),
  seq: z.number().int().nonnegative(),
  // CBOR- or JSON-encoded bytes; adapter decodes per-task schema
  payload: z.instanceof(Uint8Array),
});

export type ComputePartialEvent = z.infer<typeof partialEventSchema>;

// Final result envelope
export const finalOkSchema = z.object({
  ok: z.literal(true),
  jobId: z.string().uuid(),
  task: z.string(),
  output: z.unknown(), // validated against WIT-reflected schema per task
  metrics: z
    .object({
      durationMs: z.number().int().nonnegative().optional(),
      fuelUsed: z.number().int().nonnegative().optional(),
      memPeakMb: z.number().int().nonnegative().optional(),
      cacheHit: z.boolean().optional(),
      deadlineMs: z.number().int().nonnegative().optional(),
      remainingMsAtFinish: z.number().int().nonnegative().optional(),
      logCount: z.number().int().nonnegative().optional(),
      partialFrames: z.number().int().nonnegative().optional(),
      invalidPartialsDropped: z.number().int().nonnegative().optional(),
      outputHash: z.string().optional(),
    })
    .optional(),
});

export const finalErrSchema = z.object({
  ok: z.literal(false),
  jobId: z.string().uuid(),
  task: z.string(),
  code: computeErrorCode,
  message: z.string(),
});

export const finalEventSchema = z.union([finalOkSchema, finalErrSchema]);

export type ComputeFinalEvent = z.infer<typeof finalEventSchema>;

// Helper: stable JSON stringifier for cache key computation.
// Consumers should prefer the host-provided canonicalization.
export function stableStringify(value: unknown): string {
  // Simple, deterministic stringifier by sorting object keys.
  const seen = new WeakSet();
  const stringify = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (v instanceof Uint8Array) return `u8[${Array.from(v).join(",")}]`;
    if (Array.isArray(v)) return `[${v.map(stringify).join(",")}]`;
    if (seen.has(v as object)) return '"<cycle>"';
    seen.add(v as object);
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stringify(obj[k])}`).join(",")}}`;
  };
  return stringify(value);
}
