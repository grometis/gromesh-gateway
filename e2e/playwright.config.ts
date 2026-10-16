import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  // The kind scenario has its own config and environment (e2e/kind/run.sh).
  testIgnore: "kind/**",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  // The scenario owns the compose agent and data plane; it must never run concurrently.
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.UI_URL ?? "http://127.0.0.1:5174",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 10_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
