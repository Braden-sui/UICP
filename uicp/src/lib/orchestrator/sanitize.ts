import { LEXICON } from "../wil/lexicon";

// Build the allowed verb set once
const VERBS = new Set(
  Object.values(LEXICON)
    .flatMap(e => e.verbs)
    .map(v => v.toLowerCase())
);

export function sanitizeActorResponse(raw: string): { text: string; dropped: string[] } {
  const dropped: string[] = [];
  if (!raw) return { text: "", dropped };

  // Strip BOM and trim
  let s = raw.replace(/^\uFEFF/, "");

  // Prefer explicit sentinels if present
  const m = s.match(/BEGIN WIL([\s\S]*?)END WIL/i);
  if (m && m[1]) s = m[1];

  // Drop any code fences completely (Actor shouldn't send them, but models do)
  s = s.replace(/```[\s\S]*?```/g, (block) => { dropped.push(block); return ""; });

  // Strip tool call markers (Kimi-K2 appends <|tool_call_end|> etc. after WIL)
  s = s.replace(/<\|[^|]+\|>/g, (marker) => { dropped.push(marker); return ""; });

  // Line-level filtering to WIL-only
  const lines = s.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const wil: string[] = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    const verb = lower.split(/\s+/)[0] ?? "";
    
    // Skip tool call artifacts: "emit batch [...]", "<|...>", or lines starting with "{"
    if (lower.startsWith("emit batch") || lower.startsWith("<|") || lower.startsWith("{")) {
      dropped.push(line);
      continue;
    }
    
    if (lower.startsWith("nop:") || VERBS.has(verb)) {
      wil.push(line);
    } else {
      dropped.push(line);
    }
  }

  // Early-nop guard: if there are real ops after a leading nop, drop the nop.
  if (wil.length > 1 && wil[0].toLowerCase().startsWith("nop:")) {
    dropped.push(wil.shift()!);
  }

  return { text: wil.join("\n"), dropped };
}
