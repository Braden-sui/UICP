import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load env from uicp/.env to control orchestrator and mock mode in CI and local runs
dotenv.config({ path: fileURLToPath(new URL("./.env", import.meta.url)) });

const orchestratorEnabled = (() => {
  const v = process.env.E2E_ORCHESTRATOR ?? "";
  if (!v) return false;
  const s = v.toLowerCase();
  return !(s === "0" || s === "false" || s === "off");
})();

// If orchestrator is enabled via .env, disable MOCK mode so the app hits real endpoints
const viteMockMode = orchestratorEnabled ? "false" : (process.env.VITE_MOCK_MODE ?? "true");

export default defineConfig({
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
  },
  webServer: {
    // Ensure a fresh build with MOCK mode enabled so e2e is deterministic and does not require Tauri/LLM
    command: "npm run build && npm run preview -- --host --port 4173",
    cwd: __dirname,
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    env: {
      VITE_MOCK_MODE: viteMockMode,
      // Expose E2E_ORCHESTRATOR to the preview and tests
      E2E_ORCHESTRATOR: orchestratorEnabled ? "1" : "0",
    },
  },
  projects: [
    {
      name: "default",
      testDir: "tests/e2e/specs",
      testMatch: /.*\.spec\.ts$/,
    },
    {
      name: "compute",
      testDir: "tests/e2e",
      testMatch: /compute\.smoke\.spec\.ts$/,
    },
  ],
});
