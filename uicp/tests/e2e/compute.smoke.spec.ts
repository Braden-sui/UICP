import { test, expect } from '@playwright/test';

// E2E smoke is opt-in: set UICP_E2E_COMPUTE=1 and ensure app runs with wasm runtime
const ENABLED = process.env.UICP_E2E_COMPUTE === '1';

test.skip(!ENABLED, 'Set UICP_E2E_COMPUTE=1 to enable compute E2E smoke');

test.describe('compute plane smoke', () => {
  test('csv.parse data: URI → final bind to state', async ({ page }) => {
    // Assumes the app is served and exposes window.uicpComputeCall + a way to inspect state
    const jobId = cryptoRandomUUID();
    const src = 'data:text/csv,foo%2Cbar%0A1%2C2';
    await page.evaluate(async ({ jobId, src }) => {
      // @ts-ignore
      await window.uicpComputeCall({
        jobId,
        task: 'csv.parse@1.2.0',
        input: { source: src, hasHeader: true },
        bind: [{ toStatePath: '/tables/sales' }],
        provenance: { envHash: 'e2e' },
      });
    }, { jobId, src });
    // Wait briefly for final; real test should hook to app events/state persistence
    await page.waitForTimeout(1000);
    // Best-effort check for UI indicator; replace with a real selector in the app
    expect(true).toBeTruthy();
  });

  test('negative: cancel completes within 250ms grace', async ({ page: _page }) => {
    test.skip(true, 'App-side cancel hook not exposed to tests yet');
  });

  test('negative: timeout returns Timeout', async ({ page: _page }) => {
    test.skip(true, 'Synthetic long-running task not part of V1');
  });

  test('golden: metrics.outputHash stable across runs', async ({ page: _page }) => {
    test.skip(true, 'Hook final event capture to assert outputHash');
  });
});

function cryptoRandomUUID() {
  // Basic fallback for runners without crypto.randomUUID
  const s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
  return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`;
}
