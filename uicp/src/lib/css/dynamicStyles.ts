const DYNAMIC_STYLES_ATTR = 'data-uicp-dynamic-styles';

type DeclarationValue = string | number | null | undefined;
type Declarations = Record<string, DeclarationValue>;

let dynamicSheet: CSSStyleSheet | null = null;
let resolvingSheet = false;
const pendingRules = new Map<string, Declarations>();
const ruleCache = new Map<string, CSSStyleRule>();

const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

type StyleOwner = HTMLLinkElement | HTMLStyleElement;

const findStyleOwner = (): StyleOwner | null => {
  const owner = document.querySelector(`link[${DYNAMIC_STYLES_ATTR}], style[${DYNAMIC_STYLES_ATTR}]`);
  if (!owner) return null;
  if (owner instanceof HTMLLinkElement || owner instanceof HTMLStyleElement) {
    return owner;
  }
  return null;
};

const createStyleOwner = (): StyleOwner | null => {
  if (!isBrowser) return null;
  const head = document.head ?? document.querySelector('head');
  if (!head) return null;
  // WHY: Guarantee a writable stylesheet so desktop icon positioning survives HTML regressions.
  const style = document.createElement('style');
  style.setAttribute(DYNAMIC_STYLES_ATTR, '');
  head.appendChild(style);
  return style;
};

const getOrCreateStyleOwner = (): StyleOwner | null => {
  const existing = findStyleOwner();
  if (existing) return existing;
  return createStyleOwner();
};

const scheduleSheetResolve = () => {
  if (!isBrowser || resolvingSheet || dynamicSheet) return;
  const owner = getOrCreateStyleOwner();
  if (!owner) return;

  const sheetCandidate = owner.sheet as CSSStyleSheet | null;
  if (sheetCandidate) {
    try {
      void sheetCandidate.cssRules;
      dynamicSheet = sheetCandidate;
      flushPending(sheetCandidate);
      return;
    } catch {
      // Stylesheet is not ready yet; fall through to attach the load listener.
    }
  }

  if (owner instanceof HTMLLinkElement) {
    resolvingSheet = true;
    owner.addEventListener(
      'load',
      () => {
        resolvingSheet = false;
        const loadedSheet = owner.sheet as CSSStyleSheet | null;
        if (!loadedSheet) return;
        try {
          void loadedSheet.cssRules;
          dynamicSheet = loadedSheet;
          flushPending(loadedSheet);
        } catch {
          scheduleSheetResolve();
        }
      },
      { once: true },
    );
    return;
  }
};

const resolveSheet = (): CSSStyleSheet | null => {
  if (!isBrowser) return null;
  if (dynamicSheet) {
    return dynamicSheet;
  }
  const owner = getOrCreateStyleOwner();
  if (!owner) {
    scheduleSheetResolve();
    return null;
  }
  const sheet = owner.sheet as CSSStyleSheet | null;
  if (!sheet) {
    scheduleSheetResolve();
    return null;
  }
  try {
    // Accessing cssRules can throw while the stylesheet is loading.
    void sheet.cssRules;
  } catch {
    scheduleSheetResolve();
    return null;
  }
  dynamicSheet = sheet;
  return dynamicSheet;
};

const flushPending = (sheet: CSSStyleSheet) => {
  pendingRules.forEach((declarations, selector) => {
    internalApply(sheet, selector, declarations);
  });
  pendingRules.clear();
};

const internalApply = (sheet: CSSStyleSheet, selector: string, declarations: Declarations) => {
  let rule = ruleCache.get(selector);
  if (!rule) {
    const index = sheet.insertRule(`${selector}{}`, sheet.cssRules.length);
    rule = sheet.cssRules[index] as CSSStyleRule;
    ruleCache.set(selector, rule);
  }
  const style = rule.style;
  Object.entries(declarations).forEach(([property, rawValue]) => {
    if (rawValue === null || typeof rawValue === 'undefined') {
      style.removeProperty(property);
      return;
    }
    const value = typeof rawValue === 'number' ? String(rawValue) : rawValue;
    style.setProperty(property, value);
  });
};

export const applyDynamicStyleRule = (selector: string, declarations: Declarations) => {
  if (!isBrowser) return;
  const sheet = resolveSheet();
  if (!sheet) {
    pendingRules.set(selector, { ...declarations });
    return;
  }
  internalApply(sheet, selector, declarations);
};

export const removeDynamicStyleRule = (selector: string) => {
  pendingRules.delete(selector);
  const sheet = dynamicSheet;
  if (!sheet) {
    ruleCache.delete(selector);
    return;
  }
  const rule = ruleCache.get(selector);
  if (!rule) return;
  for (let i = 0; i < sheet.cssRules.length; i += 1) {
    if (sheet.cssRules[i] === rule) {
      sheet.deleteRule(i);
      break;
    }
  }
  ruleCache.delete(selector);
};

export const escapeForSelector = (value: string): string => {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  // Minimal fallback if CSS.escape is unavailable.
  return value.replace(/["\\]/g, '\\$&');
};

export type { Declarations as DynamicStyleDeclarations };
