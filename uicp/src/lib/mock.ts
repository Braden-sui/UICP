// Deterministic planner responses keep the MOCK mode predictable for local development and tests.
import type { Batch, Envelope } from './uicp/schemas';
import { createId } from './utils';

export type MockPlannerResult = {
  summary: string;
  batch: Batch;
};

const buildWindowEnvelope = (title: string) => ({
  op: 'window.create',
  idempotencyKey: createId('window.create'),
  params: {
    id: createId('window'),
    title,
    x: 80,
    y: 80,
    width: 720,
    height: 480,
  },
} satisfies Envelope<'window.create'>);

export const mockPlanner = (input: string): MockPlannerResult => {
  const text = input.trim().toLowerCase();
  if (text.includes('notepad')) {
    const windowEnvelope = buildWindowEnvelope('Notepad');
    const replaceEnvelope: Envelope<'dom.set'> = {
      op: 'dom.set',
      idempotencyKey: createId('dom.set'),
      params: {
        windowId: windowEnvelope.params.id!,
        target: '#root',
        html: '<div class="flex h-full flex-col gap-2"><textarea aria-label="Notes" class="h-72 w-full resize-none rounded border border-slate-300 bg-white/80 p-3 shadow-sm focus:outline focus:outline-2 focus:outline-slate-400" placeholder="Start typing"></textarea></div>',
      },
    };
    return {
      summary: 'Create a minimalist notepad with a single window and textarea.',
      batch: [windowEnvelope, replaceEnvelope],
    };
  }

  if (text.includes('todo')) {
    const windowEnvelope = buildWindowEnvelope('Todo List');
    const replaceEnvelope: Envelope<'dom.set'> = {
      op: 'dom.set',
      idempotencyKey: createId('dom.set'),
      params: {
        windowId: windowEnvelope.params.id!,
        target: '#root',
        html: '<div class="space-y-3"><form data-mock="todo-form" class="flex gap-2"><input name="title" class="flex-1 rounded border border-slate-300 bg-white/80 px-3 py-2" placeholder="Add a task" /><button type="submit" class="rounded bg-slate-900 px-3 py-2 text-white">Add</button></form><div data-mock="todo-table" class="rounded border border-slate-200 bg-white/90 shadow-sm"><div class="border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase">Tasks</div><ul class="divide-y divide-slate-200" data-mock="todo-list"></ul></div></div>',
      },
    };
    return {
      summary: 'Provision a todo list window with a form and table scaffold.',
      batch: [windowEnvelope, replaceEnvelope],
    };
  }

  if (text.includes('dashboard')) {
    const windowEnvelope = buildWindowEnvelope('Dashboard');
    const replaceEnvelope: Envelope<'dom.set'> = {
      op: 'dom.set',
      idempotencyKey: createId('dom.set'),
      params: {
        windowId: windowEnvelope.params.id!,
        target: '#root',
        html: '<div class="grid grid-cols-1 gap-3 md:grid-cols-2"><section class="rounded border border-slate-200 bg-white/90 p-4 shadow-sm"><h3 class="text-sm font-semibold text-slate-600">Sales</h3><p class="text-3xl font-bold">$45k</p></section><section class="rounded border border-slate-200 bg-white/90 p-4 shadow-sm"><h3 class="text-sm font-semibold text-slate-600">Active Users</h3><p class="text-3xl font-bold">1,280</p></section><section class="rounded border border-slate-200 bg-white/90 p-4 shadow-sm"><h3 class="text-sm font-semibold text-slate-600">Conversion</h3><p class="text-3xl font-bold">4.2%</p></section><section class="rounded border border-slate-200 bg-white/90 p-4 shadow-sm"><h3 class="text-sm font-semibold text-slate-600">Status</h3><p class="text-sm text-slate-500">All systems operational.</p></section></div>',
      },
    };
    return {
      summary: 'Assemble a simple 2x2 dashboard grid.',
      batch: [windowEnvelope, replaceEnvelope],
    };
  }

  const windowEnvelope = buildWindowEnvelope('Welcome Window');
  const replaceEnvelope: Envelope<'dom.set'> = {
    op: 'dom.set',
    idempotencyKey: createId('dom.set'),
    params: {
      windowId: windowEnvelope.params.id!,
      target: '#root',
      html: `<div class="space-y-3"><h2 class="text-lg font-semibold text-slate-800">${input.trim() || 'Hello there'}</h2><p class="text-sm text-slate-600">Full control is not enabled yet. Review the plan above to apply changes.</p></div>`,
    },
  };
  return {
    summary: 'Fallback welcome window that echoes the prompt.',
    batch: [windowEnvelope, replaceEnvelope],
  };
};

export const mockApiCall = async () => ({
  ok: true,
});

