import { defineConfig, devices } from "@playwright/test";

// Acceptance runs against the Prism mock of the contract: the UI never waits for the backend.
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://127.0.0.1:5173", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    { command: "pnpm mock", url: "http://127.0.0.1:4010/me", ignoreHTTPSErrors: true, reuseExistingServer: false, timeout: 60_000 },
    { command: "pnpm dev --host 127.0.0.1 --strictPort --mode mock", env: { MOCK_URL: "http://127.0.0.1:4010" }, url: "http://127.0.0.1:5173", reuseExistingServer: false, timeout: 60_000 },
  ],
});
