import { LEXICON } from "./lexicon";
import type { OperationNameT } from "../uicp/schemas";

export type Parsed<K extends OperationNameT = OperationNameT> = {
  op: K;
  slots: Record<string, unknown>;
};

export function parseUtterance(input: string): Parsed | null {
  const canon = normalize(input);
  for (const op of Object.keys(LEXICON) as OperationNameT[]) {
    const entry = LEXICON[op];
    const text = removeSkipWords(canon, entry.skip ?? []);
    // Sort templates by descending placeholder count, then by length, so specific patterns win
    const templates = [...entry.templates].sort((a, b) => {
      const pa = (a.match(/\{[a-zA-Z0-9_]+\}/g) || []).length;
      const pb = (b.match(/\{[a-zA-Z0-9_]+\}/g) || []).length;
      if (pb !== pa) return pb - pa;
      return b.length - a.length;
    });
    const candidates = op === "api.call" ? [stripPolite(text), stripPolite(canon), text, canon] : [text];
    for (const candidate of candidates) {
      for (const tmpl of templates) {
        const m = matchTemplate(candidate, tmpl);
        if (!m) continue;
        const slots = postProcess(op, m);
        return { op, slots } as Parsed<typeof op>;
      }
    }
  }
  // Lightweight fallback for api.call common forms
  const apiText = stripPolite(removeSkipWords(canon, LEXICON["api.call"].skip ?? []));
  const api = /^\s*(?:open\s+url|visit|go\s+to)\s+(?<url>[^\s]+)\s*$/i.exec(apiText);
  if (api?.groups?.url) {
    return { op: "api.call", slots: { url: api.groups.url } } as Parsed;
  }
  return null;
}

// --- helpers ---------------------------------------------------------------

export function normalize(s: string): string {
  // Normalize quotes and whitespace, preserve original case for slots
  const q = s.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
  return q.replace(/\s+/g, " ").trim();
}

export function removeSkipWords(s: string, skips: readonly string[]): string {
  let out = s;
  for (const phrase of skips) {
    if (!phrase) continue;
    const pat = escapeRegex(phrase.trim()).replace(/\s+/g, "\\s+");
    const re = new RegExp(`(?:^|\s)${pat}(?=\s|$)`, "gi");
    out = out.replace(re, " ");
  }
  return out.replace(/\s+/g, " ").trim();
}

function stripPolite(s: string): string {
  return s.replace(/^\s*please\s+/i, "");
}

export function matchTemplate(text: string, template: string): Record<string, string> | null {
  // primary: named-capture regex
  const pattern = templateToRegex(template);
  let m = pattern.exec(text);
  if (m && m.groups) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.groups)) out[k] = (v ?? "").trim();
    return out;
  }
  // fallback: positional groups (more permissive)
  const placeholderNames = Array.from(template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)).map((x) => x[1]);
  if (placeholderNames.length === 0) return null;
  const parts: string[] = [];
  let last = 0;
  for (const match of template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)) {
    parts.push(escapeRegex(template.slice(last, match.index)));
    const name = match[1].toLowerCase();
    let body = ".+?";
    if (["width", "height", "x", "y", "zindex"].includes(name)) body = "-?\\d+";
    if (name === "url") body = "[^\n\r\t ]+";
    parts.push(`(${body})`);
    last = match.index + match[0].length;
  }
  parts.push(escapeRegex(template.slice(last)));
  const fallback = new RegExp(`^\n?\n?\s*${parts.join("")}\s*$`, "i");
  m = fallback.exec(text);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < placeholderNames.length; i++) {
    out[placeholderNames[i]] = (m[i + 1] ?? "").trim();
  }
  return out;
}

function templateToRegex(template: string): RegExp {
  // Build regex with lookahead to the next static chunk so placeholders don't over-capture.
  const parts: string[] = [];
  const re = /\{([a-zA-Z0-9_]+)\}/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  const matches: { name: string; index: number; len: number }[] = [];
  while ((m = re.exec(template)) !== null) {
    matches.push({ name: m[1], index: m.index, len: m[0].length });
  }
  for (let i = 0; i < matches.length; i++) {
    const { name, index, len } = matches[i];
    const nextIndex = i + 1 < matches.length ? matches[i + 1].index : template.length;
    const staticBefore = template.slice(cursor, index);
    const staticAfter = template.slice(index + len, nextIndex);
    parts.push(escapeRegex(staticBefore));
    // choose group pattern
    const lower = name.toLowerCase();
    let base = ".+?";
    if (["width", "height", "x", "y", "zindex"].includes(lower)) base = "-?\\d+";
    if (lower === "url") base = "[^\n\r\t ]+";
    if (lower === "method") base = "[a-z]+";
    if (lower === "id") base = "[a-z0-9-_.]+";
    const lookahead = staticAfter.length > 0 ? `(?=${escapeRegex(staticAfter)})` : "";
    // For last placeholder that can be long text, allow greedy capture
    const isLast = i === matches.length - 1;
    const isGreedyCandidate = ["html", "title", "props"].includes(lower);
    const body = isLast && isGreedyCandidate ? ".+" : base;
    parts.push(`(?<${name}>${body})${lookahead}`);
    cursor = index + len;
  }
  parts.push(escapeRegex(template.slice(cursor)));
  return new RegExp(`^\n?\n?\s*${parts.join("")}\s*$`, "i");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maybeUnquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function asNumber(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function parseMaybeJson(s: string | undefined): unknown {
  if (!s) return undefined;
  const t = s.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.parse(t);
    } catch {
      // fall through; leave as string
      return t;
    }
  }
  return t;
}

function postProcess(op: OperationNameT, raw: Record<string, string>): Record<string, unknown> {
  const slots: Record<string, unknown> = {};
  const get = (k: string) => raw[k];

  switch (op) {
    case "window.create": {
      if (get("title")) {
        const rawTitle = get("title");
        // strip accidental trailing slot text if template fallback over-captured
        const trimmed = rawTitle.replace(/\s+(width|height|size|at)\b.*$/i, "");
        slots.title = maybeUnquote(trimmed);
      }
      if (get("size")) {
        const sz = maybeUnquote(get("size"));
        const mm = /^(\d{2,5})x(\d{2,5})$/i.exec(sz);
        if (mm) {
          const w = Number(mm[1]);
          const h = Number(mm[2]);
          if (Number.isFinite(w)) slots.width = w;
          if (Number.isFinite(h)) slots.height = h;
        } else {
          (slots as any).size = sz;
        }
      }
      if (get("width")) slots.width = asNumber(get("width"));
      if (get("height")) slots.height = asNumber(get("height"));
      if (get("x")) slots.x = asNumber(get("x"));
      if (get("y")) slots.y = asNumber(get("y"));
      break;
    }
    case "window.update": {
      if (get("id")) slots.id = maybeUnquote(get("id"));
      if (get("title")) slots.title = maybeUnquote(get("title"));
      if (get("width")) slots.width = asNumber(get("width"));
      if (get("height")) slots.height = asNumber(get("height"));
      if (get("x")) slots.x = asNumber(get("x"));
      if (get("y")) slots.y = asNumber(get("y"));
      if (get("zIndex")) slots.zIndex = asNumber(get("zIndex"));
      break;
    }
    case "window.close": {
      if (get("id")) slots.id = maybeUnquote(get("id"));
      break;
    }

    case "dom.set":
    case "dom.replace":
    case "dom.append": {
      if (get("windowId")) slots.windowId = maybeUnquote(get("windowId"));
      if (get("target")) slots.target = maybeUnquote(get("target"));
      if (get("html")) slots.html = maybeUnquote(get("html"));
      break;
    }

    case "component.render": {
      if (get("id")) slots.id = maybeUnquote(get("id"));
      if (get("windowId")) slots.windowId = maybeUnquote(get("windowId"));
      if (get("target")) slots.target = maybeUnquote(get("target"));
      if (get("type")) slots.type = maybeUnquote(get("type"));
      if (get("props")) slots.props = parseMaybeJson(get("props"));
      break;
    }
    case "component.update": {
      if (get("id")) slots.id = maybeUnquote(get("id"));
      if (get("props")) slots.props = parseMaybeJson(get("props"));
      break;
    }
    case "component.destroy": {
      if (get("id")) slots.id = maybeUnquote(get("id"));
      break;
    }

    case "state.set": {
      if (get("scope")) slots.scope = maybeUnquote(get("scope"));
      if (get("key")) slots.key = maybeUnquote(get("key"));
      if (get("value")) slots.value = parseMaybeJson(get("value"));
      if (get("windowId")) slots.windowId = maybeUnquote(get("windowId"));
      break;
    }
    case "state.get":
    case "state.watch":
    case "state.unwatch": {
      if (get("scope")) slots.scope = maybeUnquote(get("scope"));
      if (get("key")) slots.key = maybeUnquote(get("key"));
      if (get("windowId")) slots.windowId = maybeUnquote(get("windowId"));
      break;
    }

    case "api.call": {
      if (get("method")) slots.method = maybeUnquote(get("method")).toUpperCase();
      if (get("url")) slots.url = maybeUnquote(get("url"));
      if (get("headers")) slots.headers = parseMaybeJson(get("headers"));
      if (get("body")) slots.body = parseMaybeJson(get("body"));
      break;
    }

    case "txn.cancel": {
      if (get("id")) slots.id = maybeUnquote(get("id"));
      break;
    }
  }

  return slots;
}
