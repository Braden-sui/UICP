/**
 * ComponentRenderer Module
 * 
 * Factory for rendering UI components.
 * Unknown component types render neutral invisible frames (no visible placeholders).
 * 
 * PR 4: Extracted from adapter.lifecycle.ts monolith
 */

import type { DomApplier } from './domApplier';
import type { OperationParamMap } from '../../schema';
import { escapeHtml } from './adapter.security';

export interface ComponentRenderer {
  render(params: OperationParamMap['component.render']): Promise<void>;
  getMarkup(params: OperationParamMap['component.render']): string;
}

type ComponentFactory = (params: OperationParamMap['component.render']) => string;

/**
 * Registry of known component types
 */
const componentRegistry: Record<string, ComponentFactory> = {
  form: () =>
    '<form class="flex flex-col gap-2"><input class="rounded border border-slate-300 px-3 py-2" placeholder="Field" /><button type="submit" class="self-start rounded bg-slate-900 px-3 py-2 text-white">Submit</button></form>',

  table: () =>
    '<div class="rounded border border-slate-200 bg-white/90 shadow-sm"><div class="border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase">Table</div><table class="w-full divide-y divide-slate-200 text-sm"><tbody><tr><td class="px-3 py-2">Sample row</td></tr></tbody></table></div>',

  modal: (params) => {
    const title =
      typeof params.props === 'object' && params.props && 'title' in params.props
        ? String((params.props as Record<string, unknown>).title)
        : 'Modal';
    // WHY: Escape title to prevent XSS. Use neutral body with no placeholder text.
    return (
      '<div class="rounded-lg border border-slate-200 bg-white/95 p-4 shadow-lg"><h2 class="text-lg font-semibold">' +
      escapeHtml(title) +
      '</h2><div class="text-sm text-slate-600" aria-hidden="true"></div></div>'
    );
  },

  button: (params) => {
    const label =
      typeof params.props === 'object' && params.props && 'label' in params.props
        ? String((params.props as Record<string, unknown>).label)
        : 'Button';
    const cmd =
      typeof params.props === 'object' && params.props && 'command' in params.props
        ? String((params.props as Record<string, unknown>).command)
        : undefined;
    // WHY: Escape both attribute and text to prevent XSS
    const dataAttr = cmd ? ` data-command="${escapeHtml(cmd)}"` : '';
    return `<button class="button-primary rounded px-3 py-2"${dataAttr}>${escapeHtml(label)}</button>`;
  },

  cell: (params) => {
    const text =
      typeof params.props === 'object' && params.props && 'text' in params.props
        ? String((params.props as Record<string, unknown>).text)
        : '';
    // WHY: Escape cell text to prevent XSS via component props
    return `<div class="flex h-20 w-20 items-center justify-center rounded border border-slate-300 bg-white text-xl font-semibold">${escapeHtml(text)}</div>`;
  },

  grid: () =>
    '<div class="grid grid-cols-3 gap-2">' +
    Array.from(
      { length: 9 },
      () =>
        '<div class="flex h-20 w-20 items-center justify-center rounded border border-slate-300 bg-white text-xl font-semibold"></div>'
    ).join('') +
    '</div>',
};

/**
 * Create a ComponentRenderer instance bound to a DomApplier.
 */
export const createComponentRenderer = (
  domApplier: DomApplier,
  options?: {
    onUnknownComponent?: (type: string) => void;
  }
): ComponentRenderer => {
  /**
   * Get HTML markup for component type
   */
  const getMarkup = (params: OperationParamMap['component.render']): string => {
    const type = params.type.toLowerCase();

    // Check registry for exact match
    if (componentRegistry[type]) {
      return componentRegistry[type](params);
    }

    // Check for partial matches (e.g., "contact-form" matches "form")
    for (const [key, factory] of Object.entries(componentRegistry)) {
      if (type.includes(key)) {
        return factory(params);
      }
    }

    // Unknown component: emit telemetry and render neutral frame
    if (options?.onUnknownComponent) {
      options.onUnknownComponent(type);
    }

    // CRITICAL: No visible placeholder text. Neutral invisible frame only.
    return '<div class="rounded border border-dashed border-slate-300 p-4" data-component-unknown="true" style="display:none" aria-hidden="true"></div>';
  };

  /**
   * Render component into target window
   */
  const render = async (params: OperationParamMap['component.render']): Promise<void> => {
    const html = getMarkup(params);

    // Use DomApplier to handle the actual DOM mutation
    await domApplier.apply({
      windowId: params.windowId,
      target: params.target,
      html,
      mode: 'set',
      sanitize: true,
    });
  };

  return {
    render,
    getMarkup,
  };
};

/**
 * Test helper: Register custom component type
 */
export const registerComponentType = (type: string, factory: ComponentFactory): void => {
  componentRegistry[type] = factory;
};

/**
 * Test helper: Get list of registered component types
 */
export const getRegisteredTypes = (): string[] => {
  return Object.keys(componentRegistry);
};
