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
type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const asRecord = (value: unknown): UnknownRecord => (isRecord(value) ? value : {});

const recordArray = (value: unknown): UnknownRecord[] => {
  return Array.isArray(value) ? value.filter(isRecord) : [];
};

const readString = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

const tryStringify = (value: unknown): string | null => {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
};

register(
    'data.table',
    (params) => {
      const props = asRecord(params.props);
      const normalizeColumn = (value: unknown): { key: string; label: string } | null => {
        if (typeof value === 'string') {
          const trimmed = value.trim();
          if (!trimmed) return null;
          return { key: trimmed, label: trimmed };
        }
        if (isRecord(value)) {
          const keyCandidate = typeof value.key === 'string' ? value.key : typeof value.label === 'string' ? value.label : '';
          const key = keyCandidate.trim();
          if (!key) return null;
          const label = typeof value.label === 'string' && value.label.trim() ? value.label : key;
          return { key, label };
        }
        return null;
      };
      const columns = Array.isArray(props.columns)
        ? props.columns
            .map(normalizeColumn)
            .filter((column): column is { key: string; label: string } => column !== null)
        : [];
      const rows = recordArray(props.rows);
      const dense = Boolean(props.dense);
      const header =
        '<thead>' +
        '<tr>' +
        columns
          .map((column) => {
            return `<th class="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-600">${escapeHtml(column.label)}</th>`;
          })
          .join('') +
        '</tr>' +
        '</thead>';
      const body =
        '<tbody class="divide-y divide-slate-200">' +
        rows
          .map((row) => {
            const cells = columns.map((column) => {
              const value = row[column.key];
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
    'script.panel',
    (params) => {
      const props = asRecord(params.props);
      const panelId = typeof props.id === 'string' && props.id.trim() ? props.id : createId('panel');
      const attrs = `class="uicp-script-panel" data-script-panel-id="${escapeHtml(panelId)}"`;
      // Content managed by lifecycle via state watcher; keep wrapper empty initially
      return `<div ${attrs}></div>`;
    },
    'id: string, source?: string, module?: object',
    '{ op: "component.render", params: { windowId: "win-app", target: "#root", type: "script.panel", props: { id: "panel-1" } } }'
  );

register(
    'form.v1',
    (params) => {
      const props = asRecord(params.props);
      const fields = recordArray(props.fields);
      const submitLabel = readString(props.submitLabel, 'Submit');
      const schemaJson = props.submitSchema !== undefined ? tryStringify(props.submitSchema) : null;
      const inputs = fields
        .map((f) => {
          const name = readString(f.name);
          const label = readString(f.label, name);
          const type = readString(f.type, 'text');
          const placeholder = readString(f.placeholder);
          const required = Boolean(f.required);
          if (type === 'textarea') {
            return `<label class="flex flex-col gap-1 text-sm text-slate-600"><span class="font-semibold text-slate-700">${escapeHtml(label)}</span><textarea name="${escapeHtml(name)}" class="rounded border border-slate-300 px-3 py-2"></textarea></label>`;
          }
          return `<label class="flex flex-col gap-1 text-sm text-slate-600"><span class="font-semibold text-slate-700">${escapeHtml(label)}</span><input type="${escapeHtml(type)}" name="${escapeHtml(name)}" placeholder="${escapeHtml(placeholder)}" ${required ? 'required' : ''} class="rounded border border-slate-300 px-3 py-2"/></label>`;
        })
        .join('');
      const schemaAttr = schemaJson ? ` data-submit-schema='${escapeHtml(schemaJson)}'` : '';
      return `<form class="flex flex-col gap-3"${schemaAttr}>${inputs}<button type="submit" class="self-start rounded bg-slate-900 px-3 py-2 text-white">${escapeHtml(submitLabel)}</button></form>`;
    },
    'fields: Array<{name,label,type?,placeholder?,required?}>, submitLabel?: string, submitSchema?: object',
    '{ op: "component.render", params: { windowId: "win-app", target: "#root", type: "form.v1", props: { fields: [{ name: "q", label: "Query" }] } } }'
  );

register(
    'modal.v1',
    (params) => {
      const props = asRecord(params.props);
      const title = readString(props.title, 'Modal');
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
      const props = asRecord(params.props);
      const items = recordArray(props.items);
      const ordered = Boolean(props.ordered);
      const tag = ordered ? 'ol' : 'ul';
      const inner = items
        .map((item) => `<li class="px-3 py-1">${escapeHtml(readString(item.text))}</li>`)
        .join('');
      return `<${tag} class="rounded border border-slate-200 bg-white/90 shadow-sm">${inner}</${tag}>`;
    },
    'items: Array<{text:string}>, ordered?: boolean',
    '{ op: "component.render", params: { windowId: "win-app", target: "#root", type: "list.v1", props: { items: [{ text: "One" }, { text: "Two" }] } } }'
  );

register(
    'button.v1',
    (params) => {
      const props = asRecord(params.props);
      const label = readString(props.label, 'Button');
      const command = typeof props.command === 'string' ? props.command : undefined;
      const dataAttr = command ? ` data-command="${escapeHtml(command)}"` : '';
      return `<button class="button-primary rounded px-3 py-2"${dataAttr}>${escapeHtml(label)}</button>`;
    },
    'label: string, command?: string',
    '{ op: "component.render", params: { windowId: "win-app", target: "#root", type: "button.v1", props: { label: "Go" } } }'
  );

register(
    'data.view',
    (params) => {
      const props = asRecord(params.props);
      const rawScope = readString(props.scope, 'window');
      const scope = rawScope === 'workspace' || rawScope === 'global' ? rawScope : 'window';
      const key = readString(props.path);
      const rawTransform = readString(props.transform, 'json');
      const transform = rawTransform === 'count' || rawTransform === 'keys' || rawTransform === 'string' ? rawTransform : 'json';
      let value: unknown;
      try {
        value = readStateRef ? readStateRef(scope, key, params.windowId) : undefined;
      } catch {
        value = undefined;
      }
      const display = (() => {
        if (transform === 'count') {
          if (Array.isArray(value)) return String(value.length);
          if (isRecord(value)) return String(Object.keys(value).length);
        }
        if (transform === 'keys' && isRecord(value)) {
          return escapeHtml(Object.keys(value).join(', '));
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
