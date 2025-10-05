import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: "tests/e2e/specs",
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
      VITE_MOCK_MODE: 'true',
    },
  },
});
