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
    command: "npm run preview -- --host --port 4173",
    cwd: __dirname,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
