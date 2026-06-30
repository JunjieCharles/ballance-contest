import { defineConfig } from "@playwright/test";
import { join } from "node:path";

const e2eDataRoot = join(process.cwd(), ".runtime", `e2e-data-${process.pid}`);

export default defineConfig({
  testDir: "test/e2e",
  outputDir: ".runtime/playwright-results",
  timeout: 30_000,
  workers: 1,
  webServer: {
    command: "node scripts/run-e2e-server.mjs",
    url: "http://127.0.0.1:32114/api/v1/health",
    reuseExistingServer: false,
    env: {
      BALLANCE_BOOTSTRAP_TOKEN: "e2e-bootstrap-token",
      BALLANCE_DATA_ROOT: e2eDataRoot
    },
    timeout: 30_000
  },
  use: {
    baseURL: "http://127.0.0.1:32114",
    trace: "retain-on-failure"
  },
  projects: [
    { name: "Microsoft Edge", use: { browserName: "chromium", channel: "msedge" } },
    { name: "Google Chrome", use: { browserName: "chromium", channel: "chrome" } }
  ]
});
