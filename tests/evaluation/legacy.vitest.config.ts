import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: "test-results/cache/legacy-vitest",
  test: {
    include: ["tests/evaluation/legacy/**/*.test.ts"],
    reporters: ["default", "json"],
    outputFile: "test-results/legacy/results.json",
    coverage: { reportsDirectory: "test-results/legacy/coverage" },
  },
});
