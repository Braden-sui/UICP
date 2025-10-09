// Utility helpers keep DOM access predictable and testable across the adapter and planner bridge.
export const createId = (prefix = 'id') => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
};

export const nextFrame = () =>
  new Promise<number>((resolve) => {
    requestAnimationFrame((ts) => resolve(ts));
  });

export const createFrameCoalescer = () => {
  let raf: number | null = null;
  let queue: Array<() => void> = [];
  return {
    schedule(fn: () => void) {
      queue.push(fn);
      if (raf !== null) return;
      raf = requestAnimationFrame(() => {
        const copy = queue.slice();
        queue = [];
        raf = null;
        for (const job of copy) job();
      });
    },
    flushNow() {
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      const copy = queue.slice();
      queue = [];
      for (const job of copy) job();
    },
  };
};

export const sanitizeHtml = (input: string) =>
  input
    // Remove script/style tags entirely
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '')
    // Neutralise inline event handlers like onclick=, oninput=
    .replace(/\son[a-z]+\s*=/gi, ' data-attr=')
    // Disallow javascript: URLs
    .replace(/javascript:/gi, '')
    // Forbid dangerous container elements outright (conservative)
    .replace(/<\s*(iframe|object|embed|math|link|meta|base)\b[\s\S]*?>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    // Remove standalone self-closing forms too
    .replace(/<\s*(iframe|object|embed|math|link|meta|base)\b[\s\S]*?\/?>/gi, '')
    // Block SVG foreignObject content, keep empty svg wrapper
    .replace(/<\s*svg[\s\S]*?<\s*foreignObject[\s\S]*?<\s*\/\s*svg\s*>/gi, '<svg></svg>')
    // Allowlist URL-bearing attributes; neutralize disallowed schemes
    .replace(/\s(href|src|action)\s*=\s*(["'])\s*([^"'>\s]+)\2/gi, (_m, attr, quote, url) => {
      try {
        const u = String(url).trim();
        const lower = u.toLowerCase();
        const ok = lower.startsWith('https:')
          || lower.startsWith('http:')
          || lower.startsWith('data:image/');
        return ok ? ` ${attr}=${quote}${u}${quote}` : ` ${attr}=${quote}#${quote}`;
      } catch {
        return ` ${attr}=${quote}#${quote}`;
      }
    });

export const isTouchDevice = () =>
  typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
