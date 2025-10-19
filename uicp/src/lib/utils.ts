import createDOMPurify from 'dompurify';

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

const isSafeUrl = (raw: string): boolean => {
  const value = raw.trim();
  if (!value) return false;
  if (value.startsWith('#')) return true;
  if (value.startsWith('//')) return false;
  if (value.startsWith('/')) return true;
  if (value.startsWith('./') || value.startsWith('../')) return true;
  const schemeMatch = /^[a-z][a-z0-9+.-]*:/i.exec(value);
  if (schemeMatch) {
    const scheme = schemeMatch[0].slice(0, -1).toLowerCase();
    return scheme === 'http' || scheme === 'https';
  }
  return !value.includes(':');
};

const SANITIZE_WHITELIST_TAGS = [
  'a',
  'abbr',
  'article',
  'aside',
  'b',
  'bdi',
  'bdo',
  'blockquote',
  'br',
  'caption',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'label',
  'li',
  'button',
  'main',
  'mark',
  'nav',
  'ol',
  'p',
  'picture',
  'pre',
  'q',
  's',
  'samp',
  'section',
  'small',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'time',
  'tr',
  'u',
  'ul',
];

const SANITIZE_WHITELIST_ATTRS = [
  'abbr',
  'align',
  'alt',
  'aria-activedescendant',
  'aria-atomic',
  'aria-autocomplete',
  'aria-busy',
  'aria-checked',
  'aria-colcount',
  'aria-colindex',
  'aria-colspan',
  'aria-controls',
  'aria-current',
  'aria-describedby',
  'aria-description',
  'aria-details',
  'aria-disabled',
  'aria-dropeffect',
  'aria-errormessage',
  'aria-expanded',
  'aria-flowto',
  'aria-grabbed',
  'aria-haspopup',
  'aria-hidden',
  'aria-invalid',
  'aria-keyshortcuts',
  'aria-label',
  'aria-labelledby',
  'aria-level',
  'aria-live',
  'aria-modal',
  'aria-multiline',
  'aria-multiselectable',
  'aria-orientation',
  'aria-owns',
  'aria-placeholder',
  'aria-pressed',
  'aria-readonly',
  'aria-required',
  'aria-roledescription',
  'aria-rowcount',
  'aria-rowindex',
  'aria-rowspan',
  'aria-selected',
  'aria-setsize',
  'aria-sort',
  'aria-valuemax',
  'aria-valuemin',
  'aria-valuenow',
  'aria-valuetext',
  'class',
  'colspan',
  'data-testid',
  'data-id',
  'data-name',
  'data-role',
  'dir',
  'download',
  'draggable',
  'headers',
  'href',
  'hreflang',
  'id',
  'lang',
  'loading',
  'rel',
  'role',
  'rowspan',
  'scope',
  'src',
  'srcset',
  'sizes',
  'tabindex',
  'target',
  'title',
  'type',
  'value',
  'width',
  'height',
];

type DOMPurifyInstance = ReturnType<typeof createDOMPurify>;

let purifier: DOMPurifyInstance | null = null;
let purifierConfigured = false;

type WindowLike = Window & typeof globalThis;

const asWindowLike = (candidate: unknown): WindowLike | undefined => {
  if (!candidate) return undefined;
  const maybe = candidate as Partial<WindowLike>;
  if (!maybe.document || typeof maybe.document !== 'object') return undefined;
  return maybe as WindowLike;
};

const ensurePurifier = (): DOMPurifyInstance => {
  if (purifier) return purifier;
  const domWindow =
    asWindowLike(typeof window !== 'undefined' ? window : undefined) ??
    asWindowLike((globalThis as { window?: unknown }).window) ??
    asWindowLike((globalThis as { document?: Document }).document?.defaultView);

  if (!domWindow || !domWindow.document) {
    // ERROR: E-UICP-0300 DOMPurify requires a window/document to operate; fail loud instead of silently passing unsanitized HTML.
    throw new Error('E-UICP-0300: sanitizeHtml requires a DOM environment');
  }

  purifier = createDOMPurify(domWindow);
  return purifier;
};

const configurePurifier = () => {
  if (!purifier || purifierConfigured) {
    return;
  }

  // WHY: Specifying ALLOWED_ATTR conflicts with ALLOW_DATA_ATTR. Use FORBID_ATTR instead.
  // INVARIANT: All data-* attributes allowed by default; dangerous attributes explicitly forbidden.
  purifier.setConfig({
    ALLOWED_TAGS: SANITIZE_WHITELIST_TAGS,
    ALLOW_DATA_ATTR: true,
    ADD_ATTR: SANITIZE_WHITELIST_ATTRS,
    FORBID_TAGS: ['form', 'input', 'textarea', 'select', 'option', 'iframe', 'embed', 'object', 'svg', 'math', 'meta', 'link', 'style'],
    FORBID_ATTR: ['xlink:href', 'xmlns', 'formaction', 'formenctype', 'formmethod', 'formnovalidate', 'formtarget', 'action', 'style', 'onload', 'onclick', 'onerror', 'onmouseover'],
    KEEP_CONTENT: false,
    SAFE_FOR_TEMPLATES: true,
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
    RETURN_TRUSTED_TYPE: false,
    SANITIZE_DOM: true,
    SANITIZE_NAMED_PROPS: true,
    USE_PROFILES: { html: true, svg: false, svgFilters: false, mathMl: false },
  });

  // WHY: DOMPurify lacks built-in srcset filtering; enforce same URL policy post-sanitize.
  purifier.addHook('afterSanitizeAttributes', (node: Element) => {
    if (!(node instanceof Element)) {
      return;
    }

    if (node.hasAttribute('style')) {
      node.removeAttribute('style');
    }

    const scrubUrl = (attr: string) => {
      if (!node.hasAttribute(attr)) return;
      const value = node.getAttribute(attr);
      if (!value) {
        node.removeAttribute(attr);
        return;
      }
      const trimmed = value.trim();
      if (!isSafeUrl(trimmed)) {
        node.removeAttribute(attr);
        return;
      }
      node.setAttribute(attr, trimmed);
    };

    scrubUrl('href');
    scrubUrl('src');

    if (node.hasAttribute('srcset')) {
      const entries = node
        .getAttribute('srcset')!
        .split(',')
        .map((candidate) => candidate.trim())
        .filter((candidate) => candidate.length > 0);
      const safeEntries: string[] = [];
      for (const entry of entries) {
        const [url, descriptor] = entry.split(/\s+/, 2);
        if (isSafeUrl(url)) {
          safeEntries.push(descriptor ? `${url.trim()} ${descriptor.trim()}` : url.trim());
        }
      }
      if (safeEntries.length > 0) {
        node.setAttribute('srcset', safeEntries.join(', '));
      } else {
        node.removeAttribute('srcset');
      }
    }

    if (node.hasAttribute('id')) {
      const currentId = node.getAttribute('id');
      if (currentId) {
        const restored = currentId.startsWith('user-content-')
          ? currentId.slice('user-content-'.length)
          : currentId;
        const isValidId = /^[A-Za-z_][A-Za-z0-9._:-]*$/.test(restored);
        if (!isValidId) {
          node.removeAttribute('id');
        } else if (restored !== currentId) {
          node.setAttribute('id', restored);
        }
      }
    }

    if (node.tagName.toLowerCase() === 'a') {
      const target = node.getAttribute('target');
      if (target === '_blank') {
        const rel = new Set((node.getAttribute('rel') ?? '').split(/\s+/).filter(Boolean));
        rel.add('noopener');
        rel.add('noreferrer');
        node.setAttribute('rel', Array.from(rel).join(' '));
      }
    }
  });

  purifierConfigured = true;
};

export const sanitizeHtml = (input: string) => {
  if (typeof input !== 'string') {
    return '';
  }
  const instance = ensurePurifier();
  configurePurifier();
  // WHY: DOMPurify ensures DOM-aware sanitisation, closing gaps left by regex-based filtering.
  // INVARIANT: sanitizeHtml always returns markup produced by DOMPurify under the isSafeUrl policy.
  const sanitized = instance.sanitize(input);
  if (typeof sanitized !== 'string') {
    // ERROR: E-UICP-0302 DOMPurify returned unexpected payload; fail instead of passing unsanitized HTML.
    throw new Error('E-UICP-0302: sanitizeHtml expected string output');
  }
  return sanitized;
};

export const isTouchDevice = () =>
  typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
