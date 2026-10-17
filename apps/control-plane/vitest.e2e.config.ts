import { defineConfig } from "vitest/config";

// Runs against a live stack (pnpm dev:up). No app code is imported here.
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e-spec.ts"],
    testTimeout: 60_000,
    // Every spec owns the compose agent while it runs: one file at a time.
    fileParallelism: false,
  },
});
