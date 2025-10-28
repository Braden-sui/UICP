import { inv } from '../bridge/tauri';

function getDoc(): Document | null {
  try {
    return typeof document !== 'undefined' ? document : null;
  } catch {
    return null;
  }
}

function ensureContainer(apppackId: string): HTMLElement[] {
  const doc = getDoc();
  if (!doc) return [];
  const nodes = Array.from(
    doc.querySelectorAll<HTMLElement>(`.uicp-miniapp[data-apppack-id="${CSS.escape(apppackId)}"]`),
  );
  return nodes;
}

async function fetchEntryHtml(id: string): Promise<string> {
  const res = await inv<string>('apppack_entry_html', { id });
  if (!res.ok) throw new Error(res.error?.message || 'apppack_entry_html failed');
  return res.value;
}

function buildSandboxedIframe(html: string): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', [
    // Allow scripts to run and same-origin so host can inject UICP safely
    'allow-scripts',
    'allow-same-origin',
    // Allow forms; no top navigation or popups by default
    'allow-forms',
  ].join(' '));
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.style.border = '0';
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  // Use srcdoc to avoid network fetch of entry html
  (iframe as unknown as { srcdoc?: string }).srcdoc = html;
  return iframe;
}

function installUICPBridge(iframe: HTMLIFrameElement) {
  try {
    const cw = iframe.contentWindow as (Window & { UICP?: unknown }) | null;
    if (!cw) return;
    const UICP = {
      net: {
        fetch: async (url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }) => {
          const res = await inv<{ status: number; ok: boolean; body?: string; headers?: Record<string, string> }>(
            'egress_fetch',
            { url, method: options?.method, headers: options?.headers, body: options?.body },
          );
          if (!res.ok) throw new Error(res.error?.message || 'egress_fetch failed');
          return res.value;
        },
      },
      compute: {
        call: async (spec: unknown) => {
          // Host exposes uicpComputeCall on top window
          const host = window as (Window & { uicpComputeCall?: (spec: unknown) => Promise<void> });
          if (typeof host.uicpComputeCall !== 'function') {
            throw new Error('compute bridge unavailable');
          }
          await host.uicpComputeCall(spec as never);
          return true;
        },
      },
    } as const;
    cw.UICP = UICP;
  } catch (err) {
    // best-effort: do not throw
    console.warn('[miniapp] failed to install UICP bridge', err);
  }
}

export async function mountMiniApp(apppackId: string) {
  const containers = ensureContainer(apppackId);
  if (containers.length === 0) return;
  const html = await fetchEntryHtml(apppackId);
  for (const el of containers) {
    // Clear placeholder and mount iframe
    const mount = el.querySelector('.uicp-miniapp-mount');
    if (mount) {
      mount.remove();
    }
    const iframe = buildSandboxedIframe(html);
    el.appendChild(iframe);
    // Inject bridge after iframe loads its DOM
    iframe.addEventListener('load', () => installUICPBridge(iframe), { once: true });
  }
}

export function mountIfPresent(apppackId: string) {
  try {
    void mountMiniApp(apppackId);
  } catch (err) {
    console.warn('[miniapp] mount failed', err);
  }
}
