/**
 * DOM Hash Utility for V1/V2 Parity Testing
 * 
 * WHY: Provides cryptographic hashing of DOM state for comparing v1 vs v2 output
 * INVARIANT: Hash algorithm must be stable (same DOM → same hash always)
 * SAFETY: Only hashes visible DOM structure, ignores transient attributes
 */

export type DOMHashResult = {
  windowId: string;
  target: string;
  hash: string;
  structure: string; // Human-readable DOM structure for debugging
};

/**
 * Compute SHA-256 hash of DOM content at (windowId, target).
 * 
 * Uses same algorithm as domApplier for consistency.
 * 
 * WHY: Enables v1/v2 parity testing by comparing hashes
 * INVARIANT: Ignores ephemeral attributes (data-*, style with dynamic values)
 * 
 * @param windowId - Window identifier
 * @param target - CSS selector within window
 * @returns Hash result with structure for debugging
 */
export async function computeDOMHash(
  windowId: string,
  target: string = '#root'
): Promise<DOMHashResult | null> {
  // Find window element
  const windowEl = document.querySelector(`[data-window-id="${windowId}"]`);
  if (!windowEl) {
    return null;
  }

  // Find target within window
  const targetEl = windowEl.querySelector(target);
  if (!targetEl) {
    return null;
  }

  // Serialize DOM to stable string
  const structure = serializeDOMStable(targetEl);
  
  // Compute SHA-256 hash
  const encoder = new TextEncoder();
  const data = encoder.encode(structure);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  return {
    windowId,
    target,
    hash,
    structure,
  };
}

/**
 * Serialize DOM element to stable string representation.
 * 
 * WHY: Provides canonical form for hashing
 * INVARIANT: Same DOM structure always produces same string
 * 
 * Rules:
 * - Include: tag names, text content, permanent attributes (id, class, type, etc.)
 * - Exclude: data-* attributes (ephemeral), inline styles (dynamic), event handlers
 * - Normalize: whitespace, attribute order (sorted), empty attributes removed
 */
function serializeDOMStable(element: Element): string {
  const parts: string[] = [];

  // Tag name (lowercase)
  const tag = element.tagName.toLowerCase();
  parts.push(`<${tag}`);

  // Attributes (sorted, filtered)
  const attrs = Array.from(element.attributes)
    .filter(attr => {
      const name = attr.name.toLowerCase();
      // Exclude ephemeral/dynamic attributes
      if (name.startsWith('data-')) return false;
      if (name === 'style') return false; // Inline styles are dynamic
      if (name.startsWith('on')) return false; // Event handlers
      if (name === 'class' && !attr.value.trim()) return false; // Empty class
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const attr of attrs) {
    const name = attr.name.toLowerCase();
    const value = attr.value.trim();
    if (value) {
      // Escape quotes in attribute values
      const escaped = value.replace(/"/g, '&quot;');
      parts.push(` ${name}="${escaped}"`);
    } else {
      // Boolean attribute (e.g., <input disabled>)
      parts.push(` ${name}`);
    }
  }

  parts.push('>');

  // Child nodes
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      // Recurse into child elements
      parts.push(serializeDOMStable(child as Element));
    } else if (child.nodeType === Node.TEXT_NODE) {
      // Include text content (normalized whitespace)
      const text = child.textContent?.trim();
      if (text) {
        // Escape HTML entities
        const escaped = text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        parts.push(escaped);
      }
    }
    // Skip comments, processing instructions, etc.
  }

  // Closing tag
  parts.push(`</${tag}>`);

  return parts.join('');
}

/**
 * Compute hashes for all targets in a window.
 * 
 * WHY: Test suites need to compare multiple regions within a window
 * 
 * @param windowId - Window identifier
 * @param targets - Array of CSS selectors to hash
 * @returns Array of hash results (nulls filtered out)
 */
export async function computeWindowHashes(
  windowId: string,
  targets: string[] = ['#root']
): Promise<DOMHashResult[]> {
  const results: DOMHashResult[] = [];
  
  for (const target of targets) {
    const result = await computeDOMHash(windowId, target);
    if (result) {
      results.push(result);
    }
  }
  
  return results;
}

/**
 * Compare two hash results for equality.
 * 
 * WHY: Test assertions need structured comparison with helpful diffs
 * 
 * @returns true if hashes match, false otherwise
 */
export function compareHashes(
  a: DOMHashResult,
  b: DOMHashResult
): boolean {
  return (
    a.windowId === b.windowId &&
    a.target === b.target &&
    a.hash === b.hash
  );
}

/**
 * Generate diff string for debugging hash mismatches.
 * 
 * WHY: When hashes don't match, developers need to see what changed
 */
export function generateHashDiff(
  a: DOMHashResult,
  b: DOMHashResult
): string {
  const lines: string[] = [];
  
  lines.push(`Window: ${a.windowId} vs ${b.windowId}`);
  lines.push(`Target: ${a.target} vs ${b.target}`);
  lines.push(`Hash: ${a.hash} vs ${b.hash}`);
  
  if (a.hash !== b.hash) {
    lines.push('\nStructure A:');
    lines.push(formatStructure(a.structure));
    lines.push('\nStructure B:');
    lines.push(formatStructure(b.structure));
  }
  
  return lines.join('\n');
}

/**
 * Format structure for readability (add indentation).
 */
function formatStructure(structure: string): string {
  let indent = 0;
  const lines: string[] = [];
  let current = '';
  
  for (let i = 0; i < structure.length; i++) {
    const char = structure[i];
    
    if (char === '<') {
      // Check if closing tag
      if (structure[i + 1] === '/') {
        indent = Math.max(0, indent - 2);
        if (current.trim()) {
          lines.push(' '.repeat(indent) + current.trim());
          current = '';
        }
        // Find end of closing tag
        const end = structure.indexOf('>', i);
        lines.push(' '.repeat(indent) + structure.slice(i, end + 1));
        i = end;
        continue;
      } else {
        // Opening tag
        if (current.trim()) {
          lines.push(' '.repeat(indent) + current.trim());
          current = '';
        }
        // Find end of opening tag
        const end = structure.indexOf('>', i);
        lines.push(' '.repeat(indent) + structure.slice(i, end + 1));
        indent += 2;
        i = end;
        continue;
      }
    }
    
    current += char;
  }
  
  if (current.trim()) {
    lines.push(' '.repeat(indent) + current.trim());
  }
  
  return lines.join('\n');
}
