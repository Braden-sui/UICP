export function summarizeMetrics({ provider, transcriptEvents, startedAt, finishedAt }) {
  const durationMs = finishedAt && startedAt ? (finishedAt - startedAt) : undefined;
  const tokens = extractTokenUsage(provider, transcriptEvents);
  const out = { provider, durationMs };
  if (tokens) out.tokens = tokens;
  return out;
}

function extractTokenUsage(provider, events) {
  if (!events || !events.length) return null;
  // Claude: look for usage: { input_tokens, output_tokens }
  if (provider === "claude") {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev && typeof ev === "object" && ev.usage && ("input_tokens" in ev.usage || "output_tokens" in ev.usage)) {
        return {
          input: ev.usage.input_tokens ?? 0,
          output: ev.usage.output_tokens ?? 0
        };
      }
    }
  }
  // Codex (OpenAI): search for { usage: { prompt_tokens, completion_tokens } } in session lines
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev && typeof ev === "object") {
      const u = ev.usage || ev.metrics || null;
      if (u) {
        const input = u.input_tokens ?? u.prompt_tokens ?? u.promptTokens ?? 0;
        const output = u.output_tokens ?? u.completion_tokens ?? u.completionTokens ?? 0;
        if (input || output) return { input, output };
      }
    }
  }
  return null;
}

