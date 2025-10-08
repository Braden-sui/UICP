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
  // Only punctuation and optional commas/spaces
  if (/^["'\}\]\)\s,]+$/.test(t)) return true;
  // Common tail from broken JSON-in-attribute (e.g., \"'}}])
  if (/(\"|['"])\s*\}\s*\}\s*\]\s*\)?\s*$/.test(t)) return true;
  return false;
}

function tryRecoverJsonFromAttribute(val: string | null): string | null {
  if (!val) return null;
  // Already looks valid
  try {
    JSON.parse(val);
    return val;
  } catch {
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
      try {
        const parsed = JSON.parse(slice);
        // Re-stringify to ensure a clean, double-quoted JSON attribute value
        return JSON.stringify(parsed);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function sanitizeCommandLabelText(node: Node) {
  if (node.nodeType !== Node.TEXT_NODE) return;
  const text = node.textContent ?? '';
  // If the label contains obvious JSON structure, trim at the first suspicious token.
  const idx = text.search(/[\[{].*\}|\"\}\}\]\]?/);
  if (idx > 0) {
    node.textContent = text.slice(0, idx).trim();
  }
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
