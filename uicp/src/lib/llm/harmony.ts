export type HarmonyMessage = {
  role: 'assistant' | 'tool';
  channel: string;
  content?: string;
  to?: string;
  name?: string;
  args?: unknown;
  rawArgs?: string;
  stop?: 'end' | 'call' | 'return';
};

export type HarmonyParseError = {
  code: 'MissingStart' | 'MissingMessageSentinel' | 'MissingEnd' | 'FinalMissing' | 'JsonParseError';
  message: string;
};

export type HarmonyParseResult = { messages: HarmonyMessage[] } | { error: HarmonyParseError };

const START_TOKEN = '<|start|>';
const MESSAGE_TOKEN = '<|message|>';
const CHANNEL_TOKEN = '<|channel|>';
const SENTINEL_REGEX = /<\|(end|call|return)\|>/g;

function normalizeChunkMarkers(input: string): string {
  return input.replace(/<<<CHUNK>>>/g, '');
}

function parseHeader(raw: string): {
  role: 'assistant' | 'tool';
  name?: string;
  channel: string;
  to?: string;
} {
  const trimmed = raw.trim();
  const channelIndex = trimmed.indexOf(CHANNEL_TOKEN);
  if (channelIndex === -1) {
    throw new Error('Missing channel token');
  }
  const rolePart = trimmed.slice(0, channelIndex).trim();
  const channelPart = trimmed.slice(channelIndex + CHANNEL_TOKEN.length).trim();

  const channelTokens = channelPart.split(/\s+/).filter(Boolean);
  const channel = channelTokens.shift() ?? '';
  let to: string | undefined;
  for (const token of [...channelTokens]) {
    if (token.startsWith('to=')) {
      to = token.slice(3);
    }
  }

  if (channel.length === 0) {
    throw new Error('Empty channel');
  }

  const roleTokens = rolePart.split(/\s+/).filter(Boolean);
  let role: 'assistant' | 'tool';
  let name: string | undefined;
  if (roleTokens[0] === 'assistant') {
    role = 'assistant';
  } else {
    role = 'tool';
    name = roleTokens[0];
  }

  return { role, name, channel, to };
}

export function parseHarmonyTurn(input: string): HarmonyParseResult {
  const source = normalizeChunkMarkers(input).replace(/<\|([a-z]+)\s+([a-z]+)\|>/gi, '<|$1$2|>');
  const messages: HarmonyMessage[] = [];
  let index = 0;

  while (index < source.length) {
    const startIndex = source.indexOf(START_TOKEN, index);
    if (startIndex === -1) {
      const remainder = source.slice(index).trim();
      if (remainder.length > 0) {
        return { error: { code: 'MissingStart', message: 'Unexpected trailing content' } };
      }
      break;
    }
    const headerStart = startIndex + START_TOKEN.length;
    const messageIndex = source.indexOf(MESSAGE_TOKEN, headerStart);
    if (messageIndex === -1) {
      return { error: { code: 'MissingMessageSentinel', message: 'Missing <|message|> token' } };
    }
    const headerRaw = source.slice(headerStart, messageIndex);
    let header;
    try {
      header = parseHeader(headerRaw);
    } catch (err) {
      return { error: { code: 'MissingMessageSentinel', message: (err as Error).message } };
    }

    const contentStart = messageIndex + MESSAGE_TOKEN.length;
    SENTINEL_REGEX.lastIndex = contentStart;
    const sentinelMatch = SENTINEL_REGEX.exec(source);
    if (!sentinelMatch) {
      return { error: { code: 'MissingEnd', message: 'Missing <|end|>/<|call|>/<|return|>' } };
    }
    const sentinelToken = sentinelMatch[0];
    const stopType = sentinelMatch[1] as 'end' | 'call' | 'return';
    const nextStart = source.indexOf(START_TOKEN, contentStart);
    if (nextStart !== -1 && sentinelMatch.index > nextStart) {
      return {
        error: { code: 'MissingEnd', message: 'Encountered next <|start|> before closing sentinel' },
      };
    }
    const content = source.slice(contentStart, sentinelMatch.index);
    index = sentinelMatch.index + sentinelToken.length;

    const msg: HarmonyMessage = {
      role: header.role,
      channel: header.channel,
      content: content,
      stop: stopType,
    };
    if (header.role === 'tool' && header.name) {
      msg.name = header.name;
    }
    if (header.role === 'assistant' && header.to) {
      msg.to = header.to;
    }

    const trimmedContent = content.trim();
    if (stopType === 'call') {
      msg.rawArgs = trimmedContent;
      try {
        msg.args = JSON.parse(trimmedContent);
      } catch {
        msg.args = undefined;
      }
    }

    if (msg.role === 'tool') {
      msg.rawArgs = trimmedContent;
      try {
        const parsed = JSON.parse(trimmedContent);
        msg.content = parsed;
        msg.args = undefined;
      } catch {
        msg.args = undefined;
        msg.content = trimmedContent;
      }
    }

    if (msg.role === 'assistant' && stopType !== 'call') {
      msg.content = trimmedContent;
    }

    messages.push(msg);
  }

  return { messages };
}

export function extractFinalJson(messages: HarmonyMessage[]): { final: string; channel: string } | null {
  const finalMsg = [...messages].reverse().find((msg) => msg.role === 'assistant' && msg.channel === 'final');
  if (!finalMsg || finalMsg.content == null) return null;
  return { final: finalMsg.content.trim(), channel: finalMsg.channel };
}

export function harmonyHasMissingEnd(result: HarmonyParseResult): result is { error: HarmonyParseError } {
  return 'error' in result;
}

export function decodeHarmonyPlan(raw: string):
  | { messages: HarmonyMessage[]; planText: string; channel: string }
  | { error: HarmonyParseError } {
  const parsed = parseHarmonyTurn(raw);
  if ('error' in parsed) return parsed;
  const final = extractFinalJson(parsed.messages);
  if (!final) {
    return { error: { code: 'FinalMissing', message: 'Harmony plan missing final channel output' } };
  }
  return { messages: parsed.messages, planText: final.final, channel: final.channel };
}

export function decodeHarmonyBatch(raw: string):
  | { messages: HarmonyMessage[]; batchText: string; channel: string }
  | { error: HarmonyParseError } {
  const parsed = parseHarmonyTurn(raw);
  if ('error' in parsed) return parsed;
  const final = extractFinalJson(parsed.messages);
  if (!final) {
    return { error: { code: 'FinalMissing', message: 'Harmony batch missing final channel output' } };
  }
  return { messages: parsed.messages, batchText: final.final, channel: final.channel };
}
