import { defineConfig } from "vitest/config";

// Vitest runs against the unit test suite under tests/unit to mirror CI.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/vitest.setup.ts"],
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
  },
});
