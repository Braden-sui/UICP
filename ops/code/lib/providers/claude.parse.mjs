export function parseStreamJson(text) {
  const events = [];
  const lines = (text || "").split(/\r?\n/);
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s);
      events.push(obj);
    } catch {
      // ignore non-JSON lines
    }
  }
  return events;
}

export function extractPatchesFromEvents(events) {
  // Naive: scan event text fields for apply_patch block
  const blocks = [];
  const re = (/\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch/g);
  for (const ev of events) {
    for (const k of Object.keys(ev)) {
      const v = ev[k];
      if (typeof v === "string") {
        let m; const copy = v;
        while ((m = re.exec(copy)) !== null) blocks.push(m[0]);
      }
    }
  }
  return blocks;
}

export function usageFromEvents(events) {
  // Heuristic: find last object having a usage-like shape
  let usage = null;
  for (const ev of events) {
    if (ev && typeof ev === "object" && ev.usage && ("input_tokens" in ev.usage || "output_tokens" in ev.usage)) {
      usage = ev.usage;
    }
  }
  return usage;
}
