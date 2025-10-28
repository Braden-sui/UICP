import { inv } from '../bridge/tauri';

type MiniappMessage = {
  __uicp?: boolean;
  op?: string;
  reqId?: string;
  installedId?: string;
  req?: unknown;
  name?: string;
  options?: unknown;
};

type ReplyPayload = Record<string, unknown>;

function reply(win: Window, reqId: string, op: string, payload: ReplyPayload) {
  try {
    win.postMessage({ __uicp: true, op, reqId, ...payload }, '*');
  } catch (error) {
    console.warn('[miniapp] failed to post reply', error);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('message', async (ev) => {
    const d: MiniappMessage = (ev?.data ?? {}) as MiniappMessage;
    if (!d || d.__uicp !== true) return;
    const src = ev.source as Window | null;
    if (!src) return;
    const op = String(d.op ?? '');
    const reqId = String(d.reqId ?? '') || Math.random().toString(36).slice(2);
    try {
      if (op === 'miniapp.bootstrap') {
        const installedId = String(d.installedId ?? '').trim();
        if (!installedId) throw new Error('installedId required');
        const res = await inv<string>('apppack_entry_html', { installed_id: installedId });
        if (!res.ok) throw new Error(res.error?.message || 'apppack_entry_html failed');
        return reply(src, reqId, 'miniapp.entry', { html: res.value });
      }
      if (op === 'egress.fetch') {
        const installedId = String(d.installedId ?? '').trim();
        if (!installedId) throw new Error('installedId required');
        const res = await inv<unknown>('egress_fetch', { installed_id: installedId, req: d.req });
        if (!res.ok) throw new Error(res.error?.message || 'egress_fetch failed');
        return reply(src, reqId, 'egress.reply', { resp: res.value });
      }
      if (op === 'compute.call') {
        const reqPayload = d?.req as { spec?: unknown } | undefined;
        const optionsPayload = d?.options as { spec?: unknown } | undefined;
        const spec = reqPayload?.spec ?? optionsPayload?.spec;
        const res = await inv<void>('compute_call', { spec });
        if (!res.ok) throw new Error(res.error?.message || 'compute_call failed');
        return reply(src, reqId, 'compute.reply', { out: { ok: true } });
      }
      if (op === 'secrets.read') {
        // Not supported: keystore does not expose plaintext reads.
        throw new Error('secrets.read unsupported');
      }
      if (op === 'fs.openDialog') {
        throw new Error('fs.openDialog unsupported');
      }
      throw new Error(`unsupported op ${op}`);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : String(error);
      reply(src, reqId, 'error', { error: message });
    }
  });
}
