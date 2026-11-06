import { defineConfig } from "vitest/config";

const production = process.env.DISCOVERY_REQUIRE_PRODUCTION === "1";

export default defineConfig({
  test: {
    include: ["typescript/tests/**/*.test.ts", "web-tests/**/*.test.ts"],
    testTimeout: 10_000,
    reporters: ["default", "junit"],
    outputFile: { junit: "reports/typescript-junit.xml" },
    coverage: {
      enabled: !production,
      provider: "v8",
      include: ["typescript/src/reference.ts"],
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "reports/typescript-coverage",
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95
      }
    }
  }
});
