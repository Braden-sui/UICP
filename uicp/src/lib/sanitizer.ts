import { sanitizeHtml } from './utils';
import type { SafeHtml } from './schema';

// WHY: Provide a DOM-coupled sanitizer outside the schema package to avoid import cycles.
// INVARIANT: Caller must pass bounded input; throws when exceeding limits.
export function sanitizeHtmlStrict(raw: string): SafeHtml {
  const MAX_HTML_LEN = 64 * 1024; // 64KB
  const src = String(raw ?? '');
  if (src.length > MAX_HTML_LEN) {
    throw new Error('html too large (max 64KB)');
  }
  const cleaned = sanitizeHtml(src);
  return cleaned as SafeHtml;
}

