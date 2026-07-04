import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.{ts,tsx}", "test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      all: true,
      include: ["packages/*/src/**/*.ts", "apps/server/src/**/*.ts", "apps/web/src/**/*.{ts,tsx}"],
      reporter: ["text", "html"]
    },
    maxWorkers: 4,
    testTimeout: 10_000
  }
});
