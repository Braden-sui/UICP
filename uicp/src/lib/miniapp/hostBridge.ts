import { inv } from '../bridge/tauri';

type Msg = {
  __uicp?: boolean;
  op?: string;
  reqId?: string;
  installedId?: string;
  req?: any;
  name?: string;
  options?: any;
};

function reply(win: Window, reqId: string, op: string, payload: any) {
  try {
    win.postMessage({ __uicp: true, op, reqId, ...payload }, '*');
  } catch (err) {
    // ignore
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('message', async (ev) => {
    const d = (ev?.data ?? {}) as Msg;
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
        const spec = d?.req?.spec ?? d?.options;
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
    } catch (e: any) {
      const message = e?.message ? String(e.message) : String(e);
      reply(src, reqId, 'error', { error: message });
    }
  });
}
