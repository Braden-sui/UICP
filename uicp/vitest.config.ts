import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Vitest runs against the unit test suite under tests/unit to mirror CI.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/vitest.setup.ts"],
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
  },
  resolve: {
    alias: {
      // Map Tauri FS calls to a test stub so adapter logic keeps working in jsdom.
      "@tauri-apps/plugin-fs": resolve(__dirname, "tests/stubs/tauri-fs.ts"),
    },
  },
});
