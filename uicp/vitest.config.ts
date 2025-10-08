import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

if (!process.env.ROLLUP_SKIP_NODE_NATIVE) {
  process.env.ROLLUP_SKIP_NODE_NATIVE = "true";
}

const includePatterns = ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"];

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
    include: includePatterns,
  },
  resolve: {
    alias: {
      // Map Tauri FS calls to a test stub so adapter logic keeps working in jsdom.
      "@tauri-apps/plugin-fs": resolve(__dirname, "tests/stubs/tauri-fs.ts"),
      "@liquidglass/react": resolve(__dirname, "tests/stubs/liquidglass-react.tsx"),
    },
  },
});
