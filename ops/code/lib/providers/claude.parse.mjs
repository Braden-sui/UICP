export function parseStreamJson(text) {
  // Back-compat shim: return just events from the hardened parser
  return parseClaudeStream(text).events;
}

export function extractPatchesFromEvents(events) {
  // Prefer known content fields; fall back to generic string scan
  const blocks = [];
  const re = (/\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch/g);
  const tryScan = (s) => {
    if (typeof s !== "string" || !s) return;
    let m; const copy = s;
    while ((m = re.exec(copy)) !== null) blocks.push(m[0]);
  };
  for (const ev of events || []) {
    if (!ev || typeof ev !== "object") continue;
    // Known Claude CLI stream-json shapes
    tryScan(ev.text);
    if (ev.delta && typeof ev.delta === "object") tryScan(ev.delta.text);
    if (ev.content && typeof ev.content === "string") tryScan(ev.content);
    // Fallback: scan all string props
    for (const k of Object.keys(ev)) {
      const v = ev[k];
      if (typeof v === "string") tryScan(v);
    }
  }
  return blocks;
}

export function usageFromEvents(events) {
  // Prefer usage from message_delta/message_end; last one wins
  let usage = null;
  for (const ev of events || []) {
    if (!ev || typeof ev !== "object") continue;
    const candidate = ev.usage || ev.delta?.usage || ev.message?.usage;
    if (candidate && ("input_tokens" in candidate || "output_tokens" in candidate)) usage = candidate;
  }
  return usage;
}

// Hardened parser with diagnostics
// Returns { events, diagnostics: { lines_total, lines_parsed, lines_non_json, events_unknown, events_dropped } }
export function parseClaudeStream(text) {
  const diagnostics = {
    lines_total: 0,
    lines_parsed: 0,
    lines_non_json: 0,
    events_unknown: 0,
    events_dropped: 0,
  };
  const events = [];
  const lines = (text || "").split(/\r?\n/);
  for (const line of lines) {
    diagnostics.lines_total++;
    const s = line.trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s);
      diagnostics.lines_parsed++;
      if (obj && typeof obj === "object") {
        // Only accept objects with a type or message/content shape; others counted as unknown
        const hasType = typeof obj.type === "string";
        if (hasType || obj.message || obj.delta || obj.usage) {
          events.push(obj);
        } else {
          diagnostics.events_unknown++;
        }
      } else {
        diagnostics.events_dropped++;
      }
    } catch {
      diagnostics.lines_non_json++;
    }
  }
  return { events, diagnostics };
}
