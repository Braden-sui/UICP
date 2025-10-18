import { beforeEach, describe, expect, it, vi } from 'vitest';

const DYNAMIC_ATTR = 'data-uicp-dynamic-styles';

const loadDynamicStyles = async () => import('../dynamicStyles');

describe('dynamicStyles runtime host', () => {
  beforeEach(() => {
    document.querySelectorAll(`[${DYNAMIC_ATTR}]`).forEach((el) => {
      el.remove();
    });
    vi.resetModules();
  });

  it('creates a style host when none exists and applies declarations', async () => {
    const { applyDynamicStyleRule } = await loadDynamicStyles();
    applyDynamicStyleRule('.foo', { left: '10px', top: '20px' });

    const styleEl = document.querySelector(`style[${DYNAMIC_ATTR}]`) as HTMLStyleElement | null;
    expect(styleEl).toBeTruthy();
    const sheet = styleEl?.sheet as CSSStyleSheet | null;
    expect(sheet).not.toBeNull();
    const rule = sheet?.cssRules[0] as CSSStyleRule | undefined;
    expect(rule?.selectorText).toBe('.foo');
    expect(rule?.style.left).toBe('10px');
    expect(rule?.style.top).toBe('20px');
  });

  it('updates existing rules instead of duplicating them', async () => {
    const { applyDynamicStyleRule } = await loadDynamicStyles();
    applyDynamicStyleRule('.bar', { left: '12px' });
    applyDynamicStyleRule('.bar', { left: '14px', top: '8px' });

    const styleEl = document.querySelector(`style[${DYNAMIC_ATTR}]`) as HTMLStyleElement | null;
    expect(styleEl).toBeTruthy();
    const sheet = styleEl?.sheet as CSSStyleSheet | null;
    expect(sheet?.cssRules.length).toBe(1);
    const rule = sheet?.cssRules[0] as CSSStyleRule | undefined;
    expect(rule?.style.left).toBe('14px');
    expect(rule?.style.top).toBe('8px');
  });
});
