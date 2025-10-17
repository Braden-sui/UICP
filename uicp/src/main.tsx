import React from 'react';
import ReactDOM from 'react-dom/client';

const LOADER_ID = 'uicp-loading-screen';

const mountLoadingScreen = () => {
  if (typeof document === 'undefined') return;
  if (document.getElementById(LOADER_ID)) return;

  // WHY: Use DOM APIs instead of innerHTML to eliminate XSS risk entirely.
  // INVARIANT: No string interpolation, no dynamic content.
  const loader = document.createElement('div');
  loader.id = LOADER_ID;

  const shell = document.createElement('div');
  shell.className = 'loading-shell';

  const logo = document.createElement('div');
  logo.className = 'loading-logo';
  logo.textContent = 'UICP';

  const text = document.createElement('p');
  text.className = 'loading-text';
  text.textContent = 'Preparing workspace…';

  const bar = document.createElement('div');
  bar.className = 'loading-bar';
  const barFill = document.createElement('div');
  barFill.className = 'loading-bar-fill';
  bar.appendChild(barFill);

  shell.appendChild(logo);
  shell.appendChild(text);
  shell.appendChild(bar);
  loader.appendChild(shell);

  document.body.appendChild(loader);
};

const removeLoadingScreen = () => {
  const loader = document.getElementById(LOADER_ID);
  if (!loader) return;
  loader.classList.add('fade-out');
  const cleanup = () => loader.remove();
  loader.addEventListener('transitionend', cleanup, { once: true });
  window.setTimeout(cleanup, 500);
};

mountLoadingScreen();

const rootElement = document.getElementById('root') as HTMLElement | null;
if (!rootElement) {
  throw new Error('#root element not found');
}
const root = ReactDOM.createRoot(rootElement);

let paintReady = false;
let bridgeReady = false;
const maybeHideLoader = () => {
  if (paintReady && bridgeReady) {
    removeLoadingScreen();
  }
};

const bootstrap = async () => {
  try {
    await import('./styles/global.css');
    const { default: App } = await import('./App');

    root.render(
      <React.StrictMode>
        <App />
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
};

void bootstrap();
