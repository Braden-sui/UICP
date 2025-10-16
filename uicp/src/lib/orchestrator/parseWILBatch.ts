import { cfg } from "../config";
import { parseUtterance } from "../wil/parse";
import { toOp } from "../wil/map";
import { sanitizeActorResponse } from "./sanitize";

export type WilBatchItem = { op: string; params: unknown } | { nop: string };
export const WIL_STATS = { parsed: 0, nops: 0, invalid: 0 };

export function parseWILBatch(text: string): WilBatchItem[] {
  // Keep old fence extractor for backwards compat, then sanitize.
  const defenced = extractFromFences(text || "");
  const { text: sanitized, dropped } = sanitizeActorResponse(defenced);
  if (cfg.wilDebug && dropped.length) {
    console.debug(`[wil] dropped ${dropped.length} non-WIL line(s):`, dropped);
  }
  const raw = sanitized
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const withinHard = Math.min(raw.length, cfg.actorBatchHard);
  const lines = raw.slice(0, withinHard);
  if (raw.length > cfg.actorBatchDefault) {
    if (lines.length === cfg.actorBatchHard) {
      lines.push("nop: batch capped");
    } else {
      // Truncate to default and append nop
      lines.length = cfg.actorBatchDefault;
      lines.push("nop: batch capped");
    }
  }

  const out: WilBatchItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Stop on first nop:* (after sanitization, this can't incorrectly be the leading token
    // if there are valid ops following).
    if (/^nop:\s*/i.test(line)) {
      if (cfg.wilDebug) console.debug(`[wil] got nop at L${i + 1}:`, line);
      out.push({ nop: line });
      WIL_STATS.nops++;
      break;
    }
    const parsed = parseUtterance(line);
    if (!parsed) {
      if (cfg.wilDebug) console.debug(`[wil] skip(non-WIL) at L${i + 1}:`, line);
      WIL_STATS.invalid++;
      // CRITICAL FIX: do NOT abort the batch — continue scanning subsequent lines.
      continue;
    }
    if (cfg.wilDebug) console.debug(`[wil] accept L${i + 1}:`, parsed.op, parsed.slots);
    out.push(toOp(parsed));
    WIL_STATS.parsed++;
  }
  return out;
}

function extractFromFences(s: string): string {
  const m = s.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  if (m && m[1]) return m[1].trim();
  return s.trim();
}
