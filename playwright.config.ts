import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:32113",
    trace: "retain-on-failure"
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } }
  ]
});
