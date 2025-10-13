// Heuristic cleanup for stray JSON token artifacts that can leak into the UI when
// LLM-generated HTML misquotes data-command attributes, leaving fragments like
//  "Note cleared\"'}}]" rendered as text nodes.
//
// This runs client-side using a MutationObserver on the workspace root, and:
// - Normalizes data-command attributes when possible (recovering JSON substring)
// - Removes adjacent text nodes consisting only of quote/bracket artifacts
// - Strips obvious JSON fragments from button/anchor labels that carry data-command
//
// The goal is to keep the UI clean without being destructive to legitimate content.

function isBracketArtifact(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // WHY: Avoid brittle regex escaping in char classes; check per-character instead.
  // INVARIANT: Only whitespace and characters in the allowed set count as artifacts.
  const allowed = new Set([',', '"', "'", ')', '}', ']']);
  let onlyArtifacts = true;
  for (const ch of t) {
    // whisker: treat any whitespace as allowed
    if (ch.trim().length === 0) continue;
    if (!allowed.has(ch)) { onlyArtifacts = false; break; }
  }
  if (onlyArtifacts) return true;
  // Common tail from broken JSON-in-attribute (e.g., "'}}])"
  if (/(?:["'])\s*\}\s*\}\s*\]\s*\)?\s*$/.test(t)) return true;
  return false;
}

type Transform = (input: string) => string;

const MAX_RECOVERY_ITERATIONS = 24;

const RECOVERY_TRANSFORMS: Transform[] = [
  stripDanglingTerminalQuote,
  convertSingleQuotedKeys,
  convertSingleQuotedValues,
  ensureQuotedKeys,
  quoteBareWordValues,
  removeTrailingCommas,
];

// Attempt to parse the JSON after applying a series of lenient, bounded transforms.
function attemptJsonRecovery(raw: string): string | null {
  const visited = new Set<string>();
  const queue: string[] = [];

  const push = (candidate: string | null) => {
    if (!candidate) return;
    const trimmed = candidate.trim();
    if (!trimmed || visited.has(trimmed)) return;
    visited.add(trimmed);
    queue.push(trimmed);
  };

  push(raw);

  let iterations = 0;
  while (queue.length && iterations < MAX_RECOVERY_ITERATIONS) {
    iterations += 1;
    const candidate = queue.shift()!;
    try {
      const parsed = JSON.parse(candidate);
      return JSON.stringify(parsed);
    } catch {
      // fallthrough – try relaxed transforms below
    }

    for (const transform of RECOVERY_TRANSFORMS) {
      const next = transform(candidate);
      if (next !== candidate) push(next);
    }
  }

  return null;
}

// Drop a trailing quote when the total count of the quote character is odd, indicating
// a likely truncated attribute value such as {"batch":[...]}".
function stripDanglingTerminalQuote(input: string): string {
  const trimmed = input.trimEnd();
  if (!trimmed) return input;
  const last = trimmed.charAt(trimmed.length - 1);
  if (last !== '"' && last !== "'") return input;
  const occurrences = trimmed.split(last).length - 1;
  if (occurrences % 2 === 0) return input;
  return trimmed.slice(0, -1);
}

// Replace single-quoted object keys with standard double-quoted keys.
function convertSingleQuotedKeys(input: string): string {
  return input.replace(/([{,]\s*)'([^']+?)'(\s*:)/g, (_, prefix: string, key: string, suffix: string) => {
    return `${prefix}"${key.replace(/"/g, '\\"')}"${suffix}`;
  });
}

// Replace single-quoted string values with double-quoted JSON strings.
function convertSingleQuotedValues(input: string): string {
  return input.replace(/:(\s*)'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, space: string, content: string) => {
    const normalized = content.replace(/\\'/g, "'"); // preserve apostrophes
    const json = JSON.stringify(normalized);
    return `:${space}${json}`;
  });
}

// Quote unquoted object keys (e.g., {action: "state.set"}).
function ensureQuotedKeys(input: string): string {
  return input.replace(/([{,]\s*)([A-Za-z_][\w-]*)(\s*:)/g, (_, prefix: string, key: string, suffix: string) => {
    return `${prefix}"${key}"${suffix}`;
  });
}

// Quote bare word values (e.g., "value":playing -> "value":"playing").
function quoteBareWordValues(input: string): string {
  return input.replace(/:(\s*)([A-Za-z_][\w.-]*)(\s*)(["'])?(?=\s*[,}\]"'])/g, (_, space: string, word: string, trailingSpace: string) => {
    const lowered = word.toLowerCase();
    if (lowered === 'true' || lowered === 'false' || lowered === 'null') {
      return `:${space}${word}${trailingSpace}`;
    }
    return `:${space}"${word}"${trailingSpace}`;
  });
}

// Remove trailing commas that often leak from model output (e.g., {"a":1,}).
function removeTrailingCommas(input: string): string {
  return input.replace(/,\s*([}\]])/g, '$1');
}

export function tryRecoverJsonFromAttribute(val: string | null): string | null {
  if (!val) return null;
  const direct = attemptJsonRecovery(val);
  if (direct) return direct;

  // Attempt to extract the first balanced-like slice from first [ or { to last ] or }
  const startArr = val.indexOf('[');
  const startObj = val.indexOf('{');
  let start = -1;
  if (startArr >= 0 && startObj >= 0) start = Math.min(startArr, startObj);
  else start = Math.max(startArr, startObj);
  const endArr = val.lastIndexOf(']');
  const endObj = val.lastIndexOf('}');
  const end = Math.max(endArr, endObj);
  if (start >= 0 && end > start) {
    const slice = val.slice(start, end + 1);
    return attemptJsonRecovery(slice);
  }

  return null;
}

function sanitizeCommandLabelText(node: Node) {
  if (node.nodeType !== Node.TEXT_NODE) return;
  const text = node.textContent ?? '';
  // WHY: Trim labels that accidentally include obvious JSON fragments.
  // Avoid complex regex with excessive escapes; compute earliest suspicious index.
  const candidates: number[] = [];
  const iBracket = text.indexOf('[');
  if (iBracket >= 0 && (text.indexOf(']', iBracket + 1) >= 0 || text.indexOf('}', iBracket + 1) >= 0)) {
    candidates.push(iBracket);
  }
  const iBrace = text.indexOf('{');
  if (iBrace >= 0 && text.indexOf('}', iBrace + 1) >= 0) {
    candidates.push(iBrace);
  }
  const iTail = text.indexOf("\"}}]");
  if (iTail >= 0) {
    candidates.push(iTail);
  }
  const idx = candidates.length ? Math.min(...candidates) : -1;
  if (idx > 0) node.textContent = text.slice(0, idx).trim();
}

function cleanAroundElement(el: Element) {
  // Fix broken data-command attribute if present
  if (el.hasAttribute('data-command')) {
    const original = el.getAttribute('data-command');
    const recovered = tryRecoverJsonFromAttribute(original);
    if (recovered && recovered !== original) {
      el.setAttribute('data-command', recovered);
    }
    // For common clickable hosts, ensure label text does not include JSON tails
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || tag === 'span' || tag === 'div') {
      // Only trim direct child text nodes to preserve nested markup
      for (const child of Array.from(el.childNodes)) {
        sanitizeCommandLabelText(child);
      }
    }
  }

  // Remove adjacent artifact text nodes
  const prev = el.previousSibling;
  if (prev && prev.nodeType === Node.TEXT_NODE && isBracketArtifact(prev.textContent ?? '')) {
    prev.parentNode?.removeChild(prev);
  }
  const next = el.nextSibling;
  if (next && next.nodeType === Node.TEXT_NODE && isBracketArtifact(next.textContent ?? '')) {
    next.parentNode?.removeChild(next);
  }
}

function traverseAndClean(node: Node) {
  if (node.nodeType === Node.ELEMENT_NODE) {
    cleanAroundElement(node as Element);
    const el = node as Element;
    // Also scan descendants that might contain data-command
    if (el.children && el.children.length) {
      for (const child of Array.from(el.children)) traverseAndClean(child);
    }
  }
}

export function installWorkspaceArtifactCleanup(root: HTMLElement): () => void {
  // Initial pass on existing DOM
  traverseAndClean(root);

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      // Clean added nodes
      for (const n of Array.from(m.addedNodes)) {
        traverseAndClean(n);
      }
      // Clean attribute changes relevant to data-command
      if (m.type === 'attributes' && m.target instanceof Element) {
        const el = m.target as Element;
        if (m.attributeName === 'data-command') {
          cleanAroundElement(el);
        }
      }
    }
  });

  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-command'],
  });

  return () => observer.disconnect();
}
