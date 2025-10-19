import { createId } from '../../utils';
import type { Batch, Envelope, OperationParamMap } from './schemas';
import type { CommandResult } from './adapter.commands';
import type { WindowRecord } from './adapter.types';

export type StructuredClarifierOption = {
  label?: string;
  value: string;
};

export type StructuredClarifierFieldSpec = {
  name?: string;
  label?: string;
  placeholder?: string;
  description?: string;
  type?: string;
  options?: StructuredClarifierOption[];
  multiline?: boolean;
  required?: boolean;
  defaultValue?: string;
};

export type StructuredClarifierBody = {
  title?: string;
  textPrompt?: string;
  description?: string;
  submit?: string;
  cancel?: string | false;
  windowId?: string;
  width?: number;
  height?: number;
  fields?: StructuredClarifierFieldSpec[];
  label?: string;
  placeholder?: string;
  multiline?: boolean;
};

export const isStructuredClarifierBody = (input: Record<string, unknown>): input is StructuredClarifierBody => {
  if (typeof input !== 'object' || input === null) return false;
  if (typeof (input as { text?: unknown }).text === 'string') return false;
  if (
    typeof (input as { textPrompt?: unknown }).textPrompt === 'string' &&
    (input as { textPrompt: string }).textPrompt.trim()
  ) {
    return true;
  }
  if (Array.isArray((input as { fields?: unknown }).fields) && (input as { fields: unknown[] }).fields.length > 0) {
    return true;
  }
  if (typeof (input as { placeholder?: unknown }).placeholder === 'string') return true;
  if (typeof (input as { label?: unknown }).label === 'string') return true;
  return false;
};

type ClarifierField = {
  name: string;
  label: string;
  placeholder?: string;
  description?: string;
  required: boolean;
  defaultValue?: string;
  type: 'text' | 'textarea' | 'select';
  options?: Array<{ label: string; value: string }>;
};

const normalizeClarifierFields = (body: StructuredClarifierBody): ClarifierField[] => {
  const fallbackField: StructuredClarifierFieldSpec = {
    name: 'answer',
    label: typeof body.label === 'string' && body.label.trim() ? body.label.trim() : 'Answer',
    placeholder: typeof body.placeholder === 'string' ? body.placeholder : undefined,
    multiline: Boolean(body.multiline),
  };

  const candidateFields = Array.isArray(body.fields)
    ? body.fields.filter((field): field is StructuredClarifierFieldSpec => Boolean(field))
    : [];

  const fieldSpecs: StructuredClarifierFieldSpec[] = candidateFields.length > 0 ? candidateFields : [fallbackField];

  return fieldSpecs
    .map((spec, index) => {
      const name = typeof spec?.name === 'string' && spec.name.trim() ? spec.name.trim() : `field_${index + 1}`;
      const label = typeof spec?.label === 'string' && spec.label.trim() ? spec.label.trim() : name;
      const placeholder = typeof spec?.placeholder === 'string' ? spec.placeholder : undefined;
      const description = typeof spec?.description === 'string' ? spec.description : undefined;
      const required = spec?.required === undefined ? true : Boolean(spec.required);
      const defaultValue = typeof spec?.defaultValue === 'string' ? spec.defaultValue : undefined;
      const inferredType = typeof spec?.type === 'string' ? spec.type.toLowerCase() : undefined;
      const multiline = inferredType === 'textarea' || Boolean(spec?.multiline);
      const options: Array<{ label: string; value: string }> | undefined = Array.isArray(spec?.options)
        ? spec.options
            .map((option: StructuredClarifierOption | null | undefined) => {
              if (!option || typeof option.value !== 'string') {
                return null;
              }
              const optionLabel =
                typeof option.label === 'string' && option.label.trim() ? option.label : option.value;
              return { label: optionLabel, value: option.value };
            })
            .filter((option): option is { label: string; value: string } => option !== null)
        : undefined;

      let type: 'text' | 'textarea' | 'select' = 'text';
      if (multiline) {
        type = 'textarea';
      } else if (inferredType === 'select' && options && options.length > 0) {
        type = 'select';
      }

      return { name, label, placeholder, description, required, defaultValue, type, options };
    })
    .filter((field) => field != null);
};

export interface ClarifierDependencies {
  executeWindowCreate: (params: OperationParamMap['window.create']) => CommandResult<string>;
  windows: Map<string, WindowRecord>;
}

export const renderStructuredClarifierForm = (
  body: StructuredClarifierBody,
  command: Envelope,
  deps: ClarifierDependencies,
): CommandResult<string> => {
  try {
    const fields = normalizeClarifierFields(body);
    if (fields.length === 0) {
      return { success: false, error: 'Clarifier fields missing' };
    }

    const prompt = typeof body.textPrompt === 'string' && body.textPrompt.trim()
      ? body.textPrompt.trim()
      : 'Please provide additional detail.';
    const submitText = typeof body.submit === 'string' && body.submit.trim() ? body.submit.trim() : 'Continue';
    const cancelText = body.cancel === false
      ? null
      : typeof body.cancel === 'string' && body.cancel.trim()
        ? body.cancel.trim()
        : 'Cancel';

    const providedWindowId = typeof body.windowId === 'string' && body.windowId.trim() ? body.windowId.trim() : undefined;
    const commandWindowId = typeof command.windowId === 'string' && command.windowId.trim() ? command.windowId.trim() : undefined;
    const windowId = providedWindowId ?? commandWindowId ?? createId('clarifier');
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : windowId;
    const width = typeof body.width === 'number' && Number.isFinite(body.width) ? body.width : undefined;
    const height = typeof body.height === 'number' && Number.isFinite(body.height) ? body.height : undefined;

    let record = deps.windows.get(windowId);
    if (!record) {
      const createResult = deps.executeWindowCreate({
        id: windowId,
        title,
        width,
        height,
      } as OperationParamMap['window.create']);
      if (!createResult.success) {
        return createResult;
      }
      record = deps.windows.get(windowId);
      if (!record) {
        return { success: false, error: `Window ${windowId} not registered` };
      }
    }

    const root = record.content.querySelector('#root');
    if (!root) {
      return { success: false, error: `Root container missing for ${windowId}` };
    }

    const statusId = `${windowId}-clarifier-status`;
    const commandPayload = {
      question: prompt,
      windowId,
      text: fields.map((field) => `${field.label}: {{form.${field.name}}}`).join('\n').trim() || `{{form.${fields[0]?.name}}}`,
      fields: fields.map((field) => ({ name: field.name, label: field.label, value: `{{form.${field.name}}}` })),
    };

    const submitCommands: Batch = [
      { op: 'api.call', params: { method: 'POST', url: 'uicp://intent', body: commandPayload } },
      {
        op: 'dom.set',
        params: {
          windowId,
          target: `#${statusId}`,
          html: '<span class="text-xs text-slate-500">Processing...</span>',
        },
      },
      { op: 'window.close', params: { id: windowId } },
    ];

    const cancelCommands: Batch | null = cancelText
      ? [{ op: 'window.close', params: { id: windowId } }]
      : null;

    const doc = root.ownerDocument ?? document;
    const container = doc.createElement('div');
    container.className = 'structured-clarifier flex flex-col gap-3 p-4';

    const promptEl = doc.createElement('p');
    promptEl.className = 'text-sm text-slate-700';
    promptEl.textContent = prompt;
    container.appendChild(promptEl);

    if (typeof body.description === 'string' && body.description.trim()) {
      const descriptionEl = doc.createElement('p');
      descriptionEl.className = 'text-xs text-slate-500';
      descriptionEl.textContent = body.description.trim();
      container.appendChild(descriptionEl);
    }

    const form = doc.createElement('form');
    form.className = 'flex flex-col gap-3';
    form.setAttribute('data-structured-clarifier', 'true');

    fields.forEach((field, index) => {
      const wrapper = doc.createElement('label');
      wrapper.className = 'flex flex-col gap-1 text-sm text-slate-600';

      const labelEl = doc.createElement('span');
      labelEl.className = 'font-semibold text-slate-700';
      labelEl.textContent = field.label;
      wrapper.appendChild(labelEl);

      let control: HTMLElement;
      if (field.type === 'textarea') {
        const textarea = doc.createElement('textarea');
        textarea.name = field.name;
        textarea.rows = 4;
        textarea.className = 'rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-400';
        if (field.placeholder) textarea.placeholder = field.placeholder;
        if (field.required) textarea.required = true;
        if (field.defaultValue) textarea.value = field.defaultValue;
        control = textarea;
      } else if (field.type === 'select') {
        const select = doc.createElement('select');
        select.name = field.name;
        select.className = 'rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-400';
        if (field.required) select.required = true;
        for (const option of field.options ?? []) {
          const optionEl = doc.createElement('option');
          optionEl.value = option.value;
          optionEl.textContent = option.label;
          if (field.defaultValue && field.defaultValue === option.value) {
            optionEl.selected = true;
          }
          select.appendChild(optionEl);
        }
        control = select;
      } else {
        const input = doc.createElement('input');
        input.type = 'text';
        input.name = field.name;
        input.className = 'rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-400';
        if (field.placeholder) input.placeholder = field.placeholder;
        if (field.required) input.required = true;
        if (field.defaultValue) input.value = field.defaultValue;
        control = input;
      }

      control.setAttribute('aria-label', field.label);
      wrapper.appendChild(control);

      if (field.description) {
        const helper = doc.createElement('span');
        helper.className = 'text-xs text-slate-500';
        helper.textContent = field.description;
        wrapper.appendChild(helper);
      }

      form.appendChild(wrapper);

      if (index === 0) {
        queueMicrotask(() => {
          (control as HTMLElement).focus();
        });
      }
    });

    const controls = doc.createElement('div');
    controls.className = 'mt-1 flex items-center gap-2';

    const submitButton = doc.createElement('button');
    submitButton.type = 'submit';
    submitButton.className = 'rounded bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700';
    submitButton.textContent = submitText;
    submitButton.setAttribute('data-command', JSON.stringify(submitCommands));
    controls.appendChild(submitButton);

    if (cancelCommands) {
      const cancelButton = doc.createElement('button');
      cancelButton.type = 'button';
      cancelButton.className = 'rounded border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-100';
      cancelButton.textContent = cancelText ?? '';
      cancelButton.setAttribute('data-command', JSON.stringify(cancelCommands));
      controls.appendChild(cancelButton);
    }

    form.appendChild(controls);

    const status = doc.createElement('div');
    status.id = statusId;
    status.className = 'text-xs text-slate-500';
    status.setAttribute('aria-live', 'polite');
    form.appendChild(status);

    container.appendChild(form);

    root.innerHTML = '';
    root.appendChild(container);
    return { success: true, value: windowId };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
};
