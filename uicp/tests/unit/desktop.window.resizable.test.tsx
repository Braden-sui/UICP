import { describe, it, expect, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import DesktopWindow from '../../src/components/DesktopWindow';

const getRuleStyle = (selector: string): CSSStyleDeclaration => {
  const sheets = Array.from(document.styleSheets) as CSSStyleSheet[];
  for (const sheet of sheets) {
    const rule = Array.from(sheet.cssRules).find(
      (cssRule): cssRule is CSSStyleRule =>
        cssRule instanceof CSSStyleRule && cssRule.selectorText === selector,
    );
    if (rule) return rule.style;
  }
  throw new Error(`Style rule ${selector} not found`);
};

const renderWindow = () =>
  render(
    <DesktopWindow id="win" title="Test Window" isOpen={true} onClose={() => undefined}>
      <div>body</div>
    </DesktopWindow>,
  );

describe('DesktopWindow resizing', () => {
  beforeEach(() => {
    // WHY: Clamp logic depends on viewport size; fix the jsdom viewport so calculations are deterministic.
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1600 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 1200 });
  });

  it('expands width and height via the southeast resize handle', async () => {
    const { container } = renderWindow();
    const dialog = container.querySelector('[data-desktop-window="win"]') as HTMLDivElement;
    const handle = dialog.querySelector('[data-resize-handle="southeast"]') as HTMLElement;
    const style = getRuleStyle('[data-desktop-window="win"]');
    expect(style.width).toBe('420px');
    expect(style.getPropertyValue('height')).toBe('');

    await act(async () => {
      handle.dispatchEvent(
        new PointerEvent('pointerdown', { pointerId: 1, bubbles: true, clientX: 520, clientY: 420, button: 0 }),
      );
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, bubbles: true, clientX: 580, clientY: 520 }));
      handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true, clientX: 580, clientY: 520 }));
    });

    const updatedStyle = getRuleStyle('[data-desktop-window="win"]');
    expect(updatedStyle.width).toBe('480px');
    expect(updatedStyle.height).toBe('380px');
  });

  it('enforces the configured minimum width when shrinking', async () => {
    const { container } = renderWindow();
    const dialog = container.querySelector('[data-desktop-window="win"]') as HTMLDivElement;
    const handle = dialog.querySelector('[data-resize-handle="east"]') as HTMLElement;

    await act(async () => {
      handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2, bubbles: true, clientX: 520, clientY: 420, button: 0 }));
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 2, bubbles: true, clientX: 120, clientY: 420 }));
      handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2, bubbles: true, clientX: 120, clientY: 420 }));
    });

    // default width is 420, minWidth resolves to floor(420 * 0.6) = 252
    const shrunkStyle = getRuleStyle('[data-desktop-window="win"]');
    expect(shrunkStyle.width).toBe('252px');
  });
});
