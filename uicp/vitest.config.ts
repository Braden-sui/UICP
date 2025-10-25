import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

if (!process.env.ROLLUP_SKIP_NODE_NATIVE) {
  process.env.ROLLUP_SKIP_NODE_NATIVE = "true";
}

const includePatterns = [
  "tests/unit/**/*.test.ts",
  "tests/unit/**/*.test.tsx",
  "src/lib/**/__tests__/**/*.test.ts",
  "src/lib/**/__tests__/**/*.test.tsx",
];

if (process.env.OLLAMA_LIVE_TEST === "1") {
  includePatterns.push("tests/live/**/*.test.ts");
}

// Vitest runs against the unit test suite under tests/unit to mirror CI. Optional live
// smoke tests are conditionally included when OLLAMA_LIVE_TEST=1 is present.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/vitest.setup.ts"],
    // CI stability: allow slower GitHub runners and ensure async graph settles
    testTimeout: 15000,
    hookTimeout: 15000,
    include: includePatterns,
  },
  resolve: {
    alias: [
      // Map Tauri FS calls to a test stub so adapter logic keeps working in jsdom.
      { find: "@tauri-apps/plugin-fs", replacement: resolve(__dirname, "tests/stubs/tauri-fs.ts") },
      { find: "@liquidglass/react", replacement: resolve(__dirname, "tests/stubs/liquidglass-react.tsx") },
      { find: "@ops/lib/httpjail", replacement: resolve(__dirname, "../ops/code/lib/httpjail.mjs") },
      { find: "@ops/lib/claude-tools", replacement: resolve(__dirname, "../ops/code/lib/claude-tools.mjs") },
      // No bridge/tauri alias: tests rely on real module with @tauri-apps mocks
      // No explicit bridge aliases: rely on @tauri-apps mocks + __TAURI_MOCKS__
    ],
  },
  server: {
    fs: {
      allow: [resolve(__dirname, ".."), resolve(__dirname, "../ops"), resolve(__dirname, "../ops/code")],
    },
  },
});
