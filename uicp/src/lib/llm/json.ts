// Shared JSON parsing helpers for planner/actor streams. These utilities
// normalise common model artefacts (code fences, channel labels) and perform
// a small amount of “salvage” work to recover the first balanced JSON payload
// from a noisy buffer. Keep the behaviour deterministic – if we cannot parse,
// we always throw instead of guessing.

const LEADING_LABEL = /^\s*(?:json|assistant|commentary|analysis|final|output)\s*:?[\t\s-]*\n?/i;
const CODE_FENCE = /```(?:json)?/gi;

export const toJsonSafe = (input: string): string => {
  if (!input) return '';
  let out = String(input)
    // Strip UTF-8 BOM and zero-width joiners that break JSON.parse.
    .replace(/\uFEFF/g, '')
    .replace(/\u200B/g, '');

  // Remove repeated “json:” / “assistant:” style prefixes if present.
  while (LEADING_LABEL.test(out)) {
    out = out.replace(LEADING_LABEL, '');
  }

  // Drop any code fences the model may have added despite instructions.
  out = out.replace(CODE_FENCE, '');

  return out.trim();
};

const OPEN_TO_CLOSE: Record<string, string> = {
  '{': '}',
  '[': ']',
};

const isOpener = (ch: string): ch is '{' | '[' => ch === '{' || ch === '[';
const isCloser = (ch: string): ch is '}' | ']' => ch === '}' || ch === ']';

const tryParse = <T>(candidate: string): T => {
  const parsed = JSON.parse(candidate) as unknown;
  if (typeof parsed === 'string') {
    // Handle models that double-encode the JSON payload as a string.
    return JSON.parse(parsed) as T;
  }
  return parsed as T;
};

const findBalancedJsonSlice = (input: string): string | null => {
  const len = input.length;
  for (let start = 0; start < len; start += 1) {
    const startChar = input[start] as string;
    if (!isOpener(startChar)) continue;
    const stack: string[] = [];
    let inString = false;
    let escape = false;
    for (let i = start; i < len; i += 1) {
      const ch = input[i] as string;
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (isOpener(ch)) {
        stack.push(ch);
        continue;
      }
      if (isCloser(ch)) {
        const last = stack.pop();
        if (!last || OPEN_TO_CLOSE[last] !== ch) {
          // Broken nesting; abandon this start position.
          break;
        }
        if (stack.length === 0) {
          return input.slice(start, i + 1);
        }
      }
    }
  }
  return null;
};

const repairTrivialJson = (candidate: string): string => {
  // Remove obvious trailing commas like {"a":1,}
  return candidate.replace(/,\s*(?=[}\]])/g, '');
};

export const parseJsonLoose = <T = unknown>(input: string): T => {
  const normalised = toJsonSafe(input);
  if (!normalised) {
    throw new Error('Empty JSON buffer');
  }

  const attempts: Array<() => T> = [
    () => tryParse<T>(normalised),
  ];

  const slice = findBalancedJsonSlice(normalised);
  if (slice) {
    attempts.push(() => tryParse<T>(slice));
    attempts.push(() => tryParse<T>(repairTrivialJson(slice)));
  }

  const quoted = normalised.trim();
  if ((quoted.startsWith('"') && quoted.endsWith('"')) || (quoted.startsWith("'") && quoted.endsWith("'"))) {
    attempts.push(() => tryParse<T>(quoted));
  }

  let lastErr: unknown;
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error('No JSON payload found in stream');
};

