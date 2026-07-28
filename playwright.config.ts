import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  outputDir: ".runtime/playwright-results",
  timeout: 30_000,
  workers: 1,
  globalSetup: "./scripts/setup-e2e-server.mjs",
  use: {
    baseURL: "http://127.0.0.1:32114",
    trace: "retain-on-failure"
  },
  projects: [
    { name: "Microsoft Edge", use: { browserName: "chromium", channel: "msedge" } },
    { name: "Google Chrome", use: { browserName: "chromium", channel: "chrome" } }
  ]
});
