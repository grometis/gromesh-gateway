import { defineConfig, devices } from "@playwright/test";

// The kind scenario: run through e2e/kind/run.sh, which sets UI_URL, CP_URL, KONG_PROXY_URL and the E2E_* ids.
export default defineConfig({
  testDir: ".",
  testMatch: "mvp.spec.ts",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"], ["html", { open: "never", outputFolder: "../playwright-report-kind" }]],
  outputDir: "../test-results-kind",
  use: {
    baseURL: process.env.UI_URL ?? "http://127.0.0.1:18080",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
