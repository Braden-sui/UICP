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
import { createId } from '../../utils';

export interface ComponentRenderer {
  render(params: OperationParamMap['component.render']): Promise<void>;
  update(params: OperationParamMap['component.update']): Promise<void>;
  destroy(params: OperationParamMap['component.destroy']): Promise<void>;
  getMarkup(params: OperationParamMap['component.render']): string;
  getCatalogSummary(): string;
  isKnownType(type: string): boolean;
}

type ComponentFactory = (params: OperationParamMap['component.render']) => string;

type ReadStateFn = (scope: 'window' | 'workspace' | 'global', key: string, windowId?: string) => unknown;
let readStateRef: ReadStateFn | undefined;

/**
 * Registry of known component types
 */
const componentRegistry: Record<string, ComponentFactory> = {};

const catalogMeta: Record<string, { props: string; example: string }> = {};

function register(name: string, factory: ComponentFactory, propsDesc: string, example: string): void {
  componentRegistry[name] = factory;
  catalogMeta[name] = { props: propsDesc, example };
}

function ensureAliases(primary: string, aliases: string[]): void {
  for (const alias of aliases) {
    componentRegistry[alias] = componentRegistry[primary];
  }
}

// Typed component implementations (module-scope so catalog summary is always available)
register(
    'data.table',
    (params) => {
      const p = (params.props ?? {}) as Record<string, unknown>;
      const columns = Array.isArray((p as any).columns) ? ((p as any).columns as Array<string | { key: string; label: string }>) : [];
      const rows = Array.isArray((p as any).rows) ? ((p as any).rows as Array<Record<string, unknown>>) : [];
      const dense = Boolean((p as any).dense);
      const header =
        '<thead>' +
        '<tr>' +
        columns
          .map((c) => {
            const label = typeof c === 'string' ? c : c && typeof (c as any).label === 'string' ? (c as any).label : (typeof c === 'object' && (c as any).key) ? (c as any).key : '';
            return `<th class="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-600">${escapeHtml(String(label))}</th>`;
          })
          .join('') +
        '</tr>' +
        '</thead>';
      const body =
        '<tbody class="divide-y divide-slate-200">' +
        rows
          .map((row) => {
            const cells = columns.map((c) => {
              const key = typeof c === 'string' ? c : (c as any)?.key ?? (c as any)?.label ?? '';
              const value = (row as any)[key];
              return `<td class="px-3 ${dense ? 'py-1' : 'py-2'}">${escapeHtml(String(value ?? ''))}</td>`;
            });
            return `<tr>${cells.join('')}</tr>`;
          })
          .join('') +
        '</tbody>';
      return `<div class="rounded border border-slate-200 bg-white/90 shadow-sm"><div class="border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase">Table</div><table class="w-full text-sm">${header}${body}</table></div>`;
    },
    'columns: Array<string|{key,label}>, rows: Array<Record<string,unknown>>, dense?: boolean',
    '{ op: "component.render", params: { windowId: "win-app", target: "#root", type: "data.table", props: { columns: ["name","age"], rows: [{ name: "Ada", age: 28 }] } } }'
  );

register(
    'form.v1',
    (params) => {
      const p = (params.props ?? {}) as Record<string, unknown>;
      const fields = Array.isArray((p as any).fields) ? ((p as any).fields as Array<Record<string, unknown>>) : [];
      const submitLabel = typeof (p as any).submitLabel === 'string' ? String((p as any).submitLabel) : 'Submit';
      const schema = (p as any).submitSchema ? JSON.stringify((p as any).submitSchema) : undefined;
      const inputs = fields
        .map((f) => {
          const name = typeof (f as any).name === 'string' ? (f as any).name : '';
          const label = typeof (f as any).label === 'string' ? (f as any).label : name;
          const type = typeof (f as any).type === 'string' ? (f as any).type : 'text';
          const placeholder = typeof (f as any).placeholder === 'string' ? (f as any).placeholder : '';
          const required = Boolean((f as any).required);
          if (type === 'textarea') {
            return `<label class="flex flex-col gap-1 text-sm text-slate-600"><span class="font-semibold text-slate-700">${escapeHtml(label)}</span><textarea name="${escapeHtml(name)}" class="rounded border border-slate-300 px-3 py-2"></textarea></label>`;
          }
          return `<label class="flex flex-col gap-1 text-sm text-slate-600"><span class="font-semibold text-slate-700">${escapeHtml(label)}</span><input type="${escapeHtml(type)}" name="${escapeHtml(name)}" placeholder="${escapeHtml(placeholder)}" ${required ? 'required' : ''} class="rounded border border-slate-300 px-3 py-2"/></label>`;
        })
        .join('');
      const schemaAttr = schema ? ` data-submit-schema='${escapeHtml(schema)}'` : '';
      return `<form class="flex flex-col gap-3"${schemaAttr}>${inputs}<button type="submit" class="self-start rounded bg-slate-900 px-3 py-2 text-white">${escapeHtml(submitLabel)}</button></form>`;
    },
    'fields: Array<{name,label,type?,placeholder?,required?}>, submitLabel?: string, submitSchema?: object',
    '{ op: "component.render", params: { windowId: "win-app", target: "#root", type: "form.v1", props: { fields: [{ name: "q", label: "Query" }] } } }'
  );

register(
    'modal.v1',
    (params) => {
      const title =
        typeof params.props === 'object' && params.props && 'title' in params.props
          ? String((params.props as Record<string, unknown>).title)
          : 'Modal';
      return (
        '<div class="rounded-lg border border-slate-200 bg-white/95 p-4 shadow-lg"><h2 class="text-lg font-semibold">' +
        escapeHtml(title) +
        '</h2><div class="text-sm text-slate-600" aria-hidden="true"></div></div>'
      );
    },
    'title?: string',
    '{ op: "component.render", params: { windowId: "win-app", target: "#root", type: "modal.v1", props: { title: "Hello" } } }'
  );

register(
    'list.v1',
    (params) => {
      const p = (params.props ?? {}) as Record<string, unknown>;
      const items = Array.isArray((p as any).items) ? ((p as any).items as Array<Record<string, unknown>>) : [];
      const ordered = Boolean((p as any).ordered);
      const tag = ordered ? 'ol' : 'ul';
      const inner = items
        .map((it) => `<li class="px-3 py-1">${escapeHtml(String((it as any).text ?? ''))}</li>`)
        .join('');
      return `<${tag} class="rounded border border-slate-200 bg-white/90 shadow-sm">${inner}</${tag}>`;
    },
    'items: Array<{text:string}>, ordered?: boolean',
    '{ op: "component.render", params: { windowId: "win-app", target: "#root", type: "list.v1", props: { items: [{ text: "One" }, { text: "Two" }] } } }'
  );

register(
    'button.v1',
    (params) => {
      const label =
        typeof params.props === 'object' && params.props && 'label' in params.props
          ? String((params.props as Record<string, unknown>).label)
          : 'Button';
      const cmd =
        typeof params.props === 'object' && params.props && 'command' in params.props
          ? String((params.props as Record<string, unknown>).command)
          : undefined;
      const dataAttr = cmd ? ` data-command="${escapeHtml(cmd)}"` : '';
      return `<button class="button-primary rounded px-3 py-2"${dataAttr}>${escapeHtml(label)}</button>`;
    },
    'label: string, command?: string',
    '{ op: "component.render", params: { windowId: "win-app", target: "#root", type: "button.v1", props: { label: "Go" } } }'
  );

register(
    'data.view',
    (params) => {
      const p = (params.props ?? {}) as Record<string, unknown>;
      const scope = (typeof (p as any).scope === 'string' ? (p as any).scope : 'window') as 'window' | 'workspace' | 'global';
      const key = typeof (p as any).path === 'string' ? (p as any).path : '';
      const transform = typeof (p as any).transform === 'string' ? (p as any).transform : 'json';
      let value: unknown;
      try {
        value = readStateRef ? readStateRef(scope, key, params.windowId) : undefined;
      } catch {
        value = undefined;
      }
      const display = (() => {
        if (transform === 'count' && value && typeof value === 'object') {
          if (Array.isArray(value)) return String(value.length);
          return String(Object.keys(value as Record<string, unknown>).length);
        }
        if (transform === 'keys' && value && typeof value === 'object' && !Array.isArray(value)) {
          return escapeHtml(Object.keys(value as Record<string, unknown>).join(', '));
        }
        if (transform === 'string') {
          return escapeHtml(String(value ?? ''));
        }
        try {
          return escapeHtml(JSON.stringify(value ?? null, null, 2));
        } catch {
          return escapeHtml(String(value ?? ''));
        }
      })();
      return `<pre class="rounded border border-slate-200 bg-white/90 p-3 text-xs leading-tight text-slate-800">${display}</pre>`;
    },
    'scope?: "window"|"workspace"|"global", path: string, transform?: "json"|"string"|"count"|"keys"',
    '{ op: "component.render", params: { windowId: "win-app", target: "#root", type: "data.view", props: { scope: "window", path: "user", transform: "json" } } }'
  );

// Back-compat aliases
ensureAliases('form.v1', ['form']);
ensureAliases('data.table', ['table']);
ensureAliases('modal.v1', ['modal']);
ensureAliases('button.v1', ['button']);

/**
 * Create a ComponentRenderer instance bound to a DomApplier.
 */
export const createComponentRenderer = (
  domApplier: DomApplier,
  options?: {
    onUnknownComponent?: (type: string) => void;
    readState?: ReadStateFn;
  }
): ComponentRenderer => {
  const instances = new Map<string, { id: string; windowId: string; target: string; type: string; props: unknown }>();
  readStateRef = options?.readState ?? readStateRef;
  /**
   * Get HTML markup for component type
   */
  const getMarkup = (params: OperationParamMap['component.render']): string => {
    const type = params.type.toLowerCase();
    if (componentRegistry[type]) {
      return componentRegistry[type](params);
    }
    for (const [key, factory] of Object.entries(componentRegistry)) {
      if (type.includes(key)) {
        return factory(params);
      }
    }
    if (options?.onUnknownComponent) {
      options.onUnknownComponent(type);
    }
    return '<div class="rounded border border-dashed border-slate-300 p-4" data-component-unknown="true" style="display:none" aria-hidden="true"></div>';
  };

  /**
   * Render component into target window
   */
  const render = async (params: OperationParamMap['component.render']): Promise<void> => {
    const componentId = params.id ?? createId('component');
    const inner = getMarkup(params);
    const html = `<div data-component-id="${escapeHtml(componentId)}">${inner}</div>`;
    instances.set(componentId, {
      id: componentId,
      windowId: params.windowId,
      target: params.target,
      type: params.type.toLowerCase(),
      props: params.props,
    });
    await domApplier.apply({
      windowId: params.windowId,
      target: params.target,
      html,
      mode: 'set',
      sanitize: false,
    });
  };

  const update = async (params: OperationParamMap['component.update']): Promise<void> => {
    const inst = instances.get(params.id);
    if (!inst) {
      throw new Error(`component not found: ${params.id}`);
    }
    const prevProps = inst.props;
    let nextProps: unknown = params.props;
    if (prevProps && typeof prevProps === 'object' && !Array.isArray(prevProps) && params.props && typeof params.props === 'object' && !Array.isArray(params.props)) {
      nextProps = { ...(prevProps as Record<string, unknown>), ...(params.props as Record<string, unknown>) };
    }
    const inner = getMarkup({ id: inst.id, windowId: inst.windowId, target: inst.target, type: inst.type, props: nextProps });
    inst.props = nextProps;
    await domApplier.apply({
      windowId: inst.windowId,
      target: `[data-component-id="${inst.id}"]`,
      html: inner,
      mode: 'set',
      sanitize: false,
    });
  };

  const destroy = async (params: OperationParamMap['component.destroy']): Promise<void> => {
    const inst = instances.get(params.id);
    if (!inst) {
      throw new Error(`component not found: ${params.id}`);
    }
    instances.delete(params.id);
    await domApplier.apply({
      windowId: inst.windowId,
      target: `[data-component-id="${inst.id}"]`,
      html: '',
      mode: 'replace',
      sanitize: false,
    });
  };

  const getCatalogSummary = (): string => {
    const lines: string[] = [];
    lines.push('Components:');
    for (const [name, meta] of Object.entries(catalogMeta)) {
      lines.push(`- ${name}`);
      lines.push(`  props: ${meta.props}`);
      lines.push(`  example: ${meta.example}`);
    }
    lines.push('Preference: Use component.render for structured UI; avoid dom.append when a catalog component applies.');
    return lines.join('\n');
  };

  const isKnownType = (type: string): boolean => {
    const t = type.toLowerCase();
    if (componentRegistry[t]) return true;
    for (const key of Object.keys(componentRegistry)) {
      if (t.includes(key)) return true;
    }
    return false;
  };

  return {
    render,
    update,
    destroy,
    getMarkup,
    getCatalogSummary,
    isKnownType,
  };
};

/**
 * Module-level helper to expose the component catalog summary to non-adapter code (e.g., orchestrator).
 */
export const getComponentCatalogSummary = (): string => {
  const lines: string[] = [];
  lines.push('Components:');
  for (const [name, meta] of Object.entries(catalogMeta)) {
    lines.push(`- ${name}`);
    lines.push(`  props: ${meta.props}`);
    lines.push(`  example: ${meta.example}`);
  }
  return lines.join('\n');
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
