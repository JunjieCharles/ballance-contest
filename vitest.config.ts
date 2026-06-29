import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.{ts,tsx}", "test/**/*.test.ts"],
    coverage: { reporter: ["text", "html"] },
    testTimeout: 10_000
  }
});
