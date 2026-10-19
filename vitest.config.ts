import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: "test-results/cache/vitest",
  test: {
    include: ["tests/**/*.test.ts"],
    outputFile: "test-results/unit/results.json",
    coverage: { reportsDirectory: "test-results/coverage" },
  },
});
