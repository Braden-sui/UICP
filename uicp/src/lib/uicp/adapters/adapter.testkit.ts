import type { OperationParamMap } from "./schemas";
import { escapeHtml } from "./adapter.security";

/**
 * Build component markup for testing.
 * Copied from v1 implementation for backward compatibility with tests.
 */
const buildComponentMarkup = (params: OperationParamMap["component.render"]): string => {
  const type = params.type.toLowerCase();
  if (type.includes("form")) {
    return '<form class="flex flex-col gap-2"><input class="rounded border border-slate-300 px-3 py-2" placeholder="Field" /><button type="submit" class="self-start rounded bg-slate-900 px-3 py-2 text-white">Submit</button></form>';
  }
  if (type.includes("table")) {
    return '<div class="rounded border border-slate-200 bg-white/90 shadow-sm"><div class="border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase">Table</div><table class="w-full divide-y divide-slate-200 text-sm"><tbody><tr><td class="px-3 py-2">Sample row</td></tr></tbody></table></div>';
  }
  if (type.includes("modal")) {
    const title = typeof params.props === "object" && params.props && "title" in params.props
      ? String(params.props.title)
      : "Modal";
    const escapedTitle = escapeHtml(title);
    return `<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"><div class="max-w-lg rounded-lg bg-white p-4 shadow-xl"><div class="border-b pb-2 text-lg font-semibold">${escapedTitle}</div><div class="py-3">Content here</div></div></div>`;
  }
  return '<div class="rounded border border-dashed border-slate-300 bg-transparent p-3"></div>';
};

export const buildComponentMarkupForTest = buildComponentMarkup;
