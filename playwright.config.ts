import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  timeout: 30_000,
  workers: 1,
  webServer: {
    command: "node apps/server/dist/main.js",
    url: "http://127.0.0.1:32113/api/v1/health",
    reuseExistingServer: false,
    env: { BALLANCE_BOOTSTRAP_TOKEN: "e2e-bootstrap-token" },
    timeout: 30_000
  },
  use: {
    baseURL: "http://127.0.0.1:32113",
    trace: "retain-on-failure"
  },
  projects: [
    { name: "Microsoft Edge", use: { browserName: "chromium", channel: "msedge" } },
    { name: "Google Chrome", use: { browserName: "chromium", channel: "chrome" } }
  ]
});
