import type { StreamEvent } from "../llm/ollama";

const PRIMARY = new Set(["json", "final", "assistant", "commentary", "text"]);

export async function collectTextFromChannels(
  stream: AsyncIterable<StreamEvent>,
  timeoutMs = 30_000,
): Promise<string> {
  const iterator = stream[Symbol.asyncIterator]();
  let out = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`LLM timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const consume = (async () => {
    try {
      while (true) {
        const { value, done } = await iterator.next();
        if (done) break;
        const ev = value as StreamEvent;
        if (ev.type === "done") break;
        if (ev.type === 'return') {
          // Prefer explicit return payload if textual
          const r = ev.result as unknown;
          if (typeof r === 'string') return r.trim();
          if (r && typeof r === 'object') {
            const rec = r as Record<string, unknown>;
            const maybe = typeof rec.text === 'string' ? (rec.text as string) : typeof rec.value === 'string' ? (rec.value as string) : undefined;
            if (maybe) return String(maybe).trim();
          }
          continue;
        }
        if (ev.type === "content") {
          const ch = (ev.channel ?? "text").toLowerCase();
          if (PRIMARY.has(ch)) out += ev.text;
        }
        // Ignore tool_call and return in WIL/text mode
      }
      return out.trim();
    } finally {
      if (timer) clearTimeout(timer);
    }
  })();

  try {
    return await Promise.race([consume, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    if (timedOut && typeof iterator.return === "function") {
      try { await iterator.return(); } catch { /* ignore */ }
    }
  }
}
