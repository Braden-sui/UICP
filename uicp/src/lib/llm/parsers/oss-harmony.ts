// Incremental Harmony decoder resilient to chunk boundaries and sloppy JSON payloads.
export type HarmonyEvent =
  | { type: 'text'; channel: 'analysis' | 'commentary' | 'final'; delta: string }
  | { type: 'tool'; name: string; args: unknown }
  | { type: 'return'; name?: string; result: unknown };

const TOKENS = ['<|start|>', '<|channel|>', '<|message|>', '<|call|>', '<|return|>', '<|end|>'] as const;
const TOKEN_REGEX = /<\|start\|\>|<\|channel\|\>|<\|message\|\>|<\|call\|\>|<\|return\|\>|<\|end\|\>/g;

const CHANNEL_PATTERN = /<\|channel\|\>\s*([a-zA-Z]+)/;
const CALL_PATTERN = /<\|call\|\>\s*([a-zA-Z0-9._-]+)/;

// Attempts to coerce malformed JSON (smart quotes, trailing commas, etc.) into valid JSON before parsing.
export function coerceJson(input: string): unknown {
  const stripped = input
    .replace(/```(\w+)?/g, '')
    .replace(/\uFEFF/g, '')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(stripped);
  } catch {
    try {
      return JSON.parse(stripped.replace(/'([^']*)'/g, (_, group: string) => `"${group.replace(/"/g, '\\"')}"`));
    } catch {
      throw new Error(`Bad JSON: ${stripped.slice(0, 200)}`);
    }
  }
}

const sanitizeText = (value: string): string => {
  return value
    .replace(/```(\w+)?/g, '')
    .replace(/\r/g, '')
    .replace(/^\s+|\s+$/g, '')
    .replace(/\u0000/g, '');
};

const nextTokenIndex = (frame: string, from: number): number => {
  let candidate = -1;
  for (const token of TOKENS) {
    const idx = frame.indexOf(token, from);
    if (idx === -1) continue;
    if (candidate === -1 || idx < candidate) candidate = idx;
  }
  return candidate;
};

export class HarmonyDecoder {
  private buffer = '';
  private currentChannel: HarmonyEvent['channel'] = 'analysis';

  // Feed raw Harmony text chunks; yields decoded events as soon as they are available.
  *push(chunk: string): Generator<HarmonyEvent> {
    if (!chunk) return;
    this.buffer += chunk;

    while (true) {
      const startIdx = this.buffer.indexOf('<|start|>');
      if (startIdx < 0) {
        if (this.buffer.length > 4096) {
          this.buffer = this.buffer.slice(-4096);
        }
        return;
      }
      const endIdx = this.buffer.indexOf('<|end|>', startIdx + '<|start|>'.length);
      if (endIdx < 0) return;

      const frame = this.buffer.slice(startIdx + '<|start|>'.length, endIdx);
      this.buffer = this.buffer.slice(endIdx + '<|end|>'.length);

      let last = 0;
      let channel = this.currentChannel;
      let match: RegExpExecArray | null;
      TOKEN_REGEX.lastIndex = 0;

      while ((match = TOKEN_REGEX.exec(frame)) !== null) {
        const token = match[0] as (typeof TOKENS)[number];
        const prelude = frame.slice(last, match.index);
        if (prelude && token !== '<|channel|>' && token !== '<|call|>' && token !== '<|return|>') {
          const text = sanitizeText(prelude);
          if (text) yield { type: 'text', channel, delta: text };
        }

        if (token === '<|channel|>') {
          const channelMatch = CHANNEL_PATTERN.exec(frame.slice(match.index));
          if (channelMatch) {
            const next = channelMatch[1].toLowerCase();
            if (next === 'analysis' || next === 'commentary' || next === 'final') {
              channel = next;
              this.currentChannel = next;
            }
          }
        } else if (token === '<|call|>') {
          const nameMatch = CALL_PATTERN.exec(frame.slice(match.index));
          const afterCall = nameMatch ? match.index + nameMatch[0].length : match.index + '<|call|>'.length;
          const nextIdx = nextTokenIndex(frame, afterCall);
          const jsonBlob = frame.slice(afterCall, nextIdx === -1 ? frame.length : nextIdx);
          const name = nameMatch ? nameMatch[1] : 'unknown';
          try {
            const args = coerceJson(jsonBlob.trim());
            yield { type: 'tool', name, args };
          } catch {
            // Ignore incomplete payloads; upstream will retry in a subsequent frame.
          }
        } else if (token === '<|return|>') {
          const afterReturn = match.index + '<|return|>'.length;
          const nextIdx = nextTokenIndex(frame, afterReturn);
          const jsonBlob = frame.slice(afterReturn, nextIdx === -1 ? frame.length : nextIdx);
          try {
            const result = coerceJson(jsonBlob.trim());
            yield { type: 'return', result };
          } catch {
            // Swallow malformed returns so the caller can inspect raw frames separately.
          }
        }

        last = match.index + token.length;
      }

      const tail = frame.slice(last);
      const text = sanitizeText(tail);
      if (text) yield { type: 'text', channel, delta: text };
    }
  }

  flush(): HarmonyEvent[] {
    const remaining = sanitizeText(this.buffer);
    this.buffer = '';
    if (!remaining) return [];
    return [{ type: 'text', channel: this.currentChannel, delta: remaining }];
  }
}
