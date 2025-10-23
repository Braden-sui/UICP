import React from 'react';
import ReactDOM from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { getComputeBridge } from './lib/bridge/globals';
import { newUuid } from './lib/utils';
import { installNetworkGuard } from './lib/security/networkGuard';

const LOADER_ID = 'uicp-loading-screen';
const MIN_LOADER_DISPLAY_MS = 300; // Minimum time to show loader (prevents flash)

// Install in-app network guard to prevent connections to disallowed hosts/ports.
// This only affects traffic from within the UICP app (no OS-level changes).
installNetworkGuard();

const hasBooleanOkFlag = (value: unknown): value is { ok: boolean } => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in value &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  );
};

// Ensure loader exists (either from static HTML or create it)
const ensureLoader = () => {
  let loader = document.getElementById(LOADER_ID);
  if (loader) return loader;

  // Fallback: create loader if HTML didn't include it
  loader = document.createElement('div');
  loader.id = LOADER_ID;
  loader.setAttribute('role', 'status');
  loader.setAttribute('aria-live', 'polite');
  loader.setAttribute('aria-busy', 'true');
  loader.setAttribute('aria-label', 'Initializing application');
  loader.className = 'loading-screen-fallback';
  
  // Simple fallback styles if critical.css didn't load
  loader.style.cssText = 'position:fixed;inset:0;background:#0a0a0f;color:#fff;display:flex;align-items:center;justify-content:center;z-index:9999;';
  loader.textContent = 'Loading...';
  
  document.body.appendChild(loader);
  return loader;
};

const removeLoadingScreen = () => {
  const loader = document.getElementById(LOADER_ID);
  if (!loader) return;

  // Update A11y attributes
  loader.setAttribute('aria-busy', 'false');
  loader.setAttribute('aria-hidden', 'true');

  // CRITICAL: Disable pointer events BEFORE fade-out so UI becomes interactive immediately
  loader.style.pointerEvents = 'none';

  loader.classList.add('fade-out');

  // Calculate actual transition duration from computed styles
  const computeTransitionMs = (): number => {
    const d = getComputedStyle(loader).transitionDuration || '0.6s';
    const n = parseFloat(d);
    return d.endsWith('ms') ? n : n * 1000;
  };

  const cleanup = () => loader.remove();
  loader.addEventListener('transitionend', cleanup, { once: true });
  // Fallback with computed duration + buffer
  window.setTimeout(cleanup, computeTransitionMs() + 100);
};

// Ensure loader is present and track when shown
ensureLoader();
const loaderShownAt = Date.now();

const finalizeLoader = () => {
  // Ensure loader displays for minimum duration to prevent jarring flash
  const elapsed = Date.now() - loaderShownAt;
  const remaining = Math.max(0, MIN_LOADER_DISPLAY_MS - elapsed);
  
  setTimeout(() => {
    removeLoadingScreen();
  }, remaining);
};

const rootElement = document.getElementById('root') as HTMLElement | null;
if (!rootElement) {
  throw new Error('#root element not found');
}
const root = ReactDOM.createRoot(rootElement);

let paintReady = false;
let bridgeReady = false;
const maybeHideLoader = () => {
  if (paintReady && bridgeReady) {
    // Notify Tauri backend to close splash and show main window
    try {
      void invoke('frontend_ready');
    } catch {
      // Best-effort notification; ignore if Tauri bridge unavailable
    }
    finalizeLoader();
  }
};

const bootstrap = async () => {
  try {
    await import('./styles/global.css');
    const { default: App } = await import('./App');
    const { default: ErrorBoundary } = await import('./components/ErrorBoundary');

    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>,
    );

    requestAnimationFrame(() => {
      paintReady = true;
      maybeHideLoader();
    });
  } catch (error) {
    console.error('Failed to bootstrap app', error);
    paintReady = true;
    maybeHideLoader();
    return;
  }

  try {
    const { initializeTauriBridge } = await import('./lib/bridge/tauri');
    await initializeTauriBridge();
  } catch (error) {
    console.error('Failed to initialise Tauri bridge', error);
  } finally {
    bridgeReady = true;
    maybeHideLoader();
  }

  // Best-effort warm-start for QuickJS via script.panel.
  // Fires once per session after module verification; non-blocking.
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      const KEY = 'uicp:warmstart:script.panel';
      if (!sessionStorage.getItem(KEY)) {
        sessionStorage.setItem(KEY, '1');
        // Verify modules are installed and QuickJS is present before warming.
        let verified = false;
        try {
          const res = await invoke<unknown>('verify_modules');
          verified = hasBooleanOkFlag(res) && res.ok === true;
        } catch {
          verified = false;
        }
        if (!verified) return;

        let hasQuickJS = false;
        try {
          const reg = await invoke<unknown>('get_modules_registry');
          if (
            typeof reg === 'object' &&
            reg !== null &&
            'modules' in reg &&
            Array.isArray((reg as { modules?: unknown }).modules)
          ) {
            const list = (reg as { modules?: Array<{ task?: unknown }> }).modules ?? [];
            hasQuickJS = list.some(
              (entry) => typeof entry?.task === 'string' && entry.task.startsWith('applet.quickjs'),
            );
          }
        } catch {
          hasQuickJS = false;
        }
        if (!hasQuickJS) return;

        const compute = getComputeBridge();
        if (typeof compute !== 'function') return;

        const moduleId = 'applet.quickjs@0.1.0';
        const source = `(() => {\n  const stableState = () => "{}";\n  const applet = {\n    init() { return stableState(); },\n    render(state) { const s = typeof state === 'string' && state.length ? state : stableState(); return \`<div data-prewarm=\\"quickjs\\">\${s}</div>\`; },\n    onEvent(_a,_p,state) { const s = typeof state === 'string' && state.length ? state : stableState(); return JSON.stringify({ next_state: s }); }\n  };\n  globalThis.__uicpApplet = applet;\n})();`;
        const job = {
          jobId: newUuid(),
          task: moduleId,
          input: { mode: 'init', source },
          timeoutMs: 4000,
          bind: [],
          cache: 'readwrite' as const,
          capabilities: {},
          replayable: false,
          workspaceId: 'default',
          provenance: { envHash: 'warmstart', agentTraceId: 'warmstart' },
        };
        void compute(job);
      }
    }
  } catch {
    // ignore warm-start failures
  }
};

void bootstrap();
