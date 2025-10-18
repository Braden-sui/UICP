import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load env from uicp/.env to control orchestrator in CI and local runs
dotenv.config({ path: fileURLToPath(new URL('./.env', import.meta.url)) });

const orchestratorEnabled = (() => {
  const v = process.env.E2E_ORCHESTRATOR ?? '';
  if (!v) return false;
  const s = v.toLowerCase();
  return !(s === '0' || s === 'false' || s === 'off');
})();

// Orchestrator E2E is opt-in via E2E_ORCHESTRATOR=1

export default defineConfig({
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
  },
  webServer: {
    // Ensure a fresh build and start preview server for Playwright tests
    command: 'npm run build && npm run preview -- --host --port 4173',
    cwd: __dirname,
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    env: {
      // Expose E2E_ORCHESTRATOR to the preview and tests
      E2E_ORCHESTRATOR: orchestratorEnabled ? '1' : '0',
    },
  },
  projects: [
    {
      name: 'default',
      testDir: 'tests/e2e/specs',
      testMatch: /.*\.spec\.ts$/,
    },
    {
      name: 'compute',
      testDir: 'tests/e2e',
      testMatch: /compute\.smoke\.spec\.ts$/,
    },
  ],
});
