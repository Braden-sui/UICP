import { cfg } from "../config";

export type ClarifyDecision =
  | { ok: true; downgraded?: boolean }
  | { ok: false; reason: string };

export function enforcePlannerCap(turnsUsed: number, questionsInBatch: number): ClarifyDecision {
  if (turnsUsed >= 1) return { ok: false, reason: "already clarified once" };
  if (questionsInBatch > cfg.followupMaxHard) return { ok: false, reason: "over hard cap" };
  if (questionsInBatch > cfg.followupMaxDefault) return { ok: true, downgraded: true };
  return { ok: true };
}

