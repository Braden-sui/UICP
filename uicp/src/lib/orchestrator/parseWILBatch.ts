import { cfg } from "../config";
import { parseUtterance } from "../wil/parse";
import { toOp } from "../wil/map";

export type WilBatchItem = { op: string; params: unknown } | { nop: string };
export const WIL_STATS = { parsed: 0, nops: 0, invalid: 0 };

export function parseWILBatch(text: string): WilBatchItem[] {
  const defenced = extractFromFences(text || '');
  const raw = defenced
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
  if (cfg.wilDebug) {
    console.debug(`[WIL] lines_in=${lines.length} raw_in=${raw.length}`);
  }
  for (const line of lines) {
    if (line.toLowerCase().startsWith("nop:")) {
      out.push({ nop: line.slice(4).trim() || "unspecified" });
      if (cfg.wilDebug) {
        console.debug(`[WIL] nop detected: ${line}`);
      }
      WIL_STATS.nops++;
      break;
    }
    const parsed = parseUtterance(line);
    if (!parsed) {
      out.push({ nop: "invalid WIL line" });
      if (cfg.wilDebug) {
        console.debug(`[WIL] invalid line: ${line}`);
      }
      WIL_STATS.invalid++;
      break;
    }
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
