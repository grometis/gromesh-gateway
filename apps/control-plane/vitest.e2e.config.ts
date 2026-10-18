import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Runs against a live stack (pnpm dev:up). No app code is imported here; the compiler library is read from its
// sources (the e2e job does not build packages), for the specs that normalise compiled configs.
export default defineConfig({
  resolve: { alias: { "@gromesh/compiler": fileURLToPath(new URL("../../packages/compiler/src/index.ts", import.meta.url)) } },
  test: {
    include: ["test/e2e/**/*.e2e-spec.ts"],
    testTimeout: 60_000,
    // Every spec owns the compose agent while it runs: one file at a time.
    fileParallelism: false,
  },
});
