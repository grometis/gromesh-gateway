import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// SWC emits decorator metadata, which Nest's dependency injection needs (esbuild does not).
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: {
    include: ["test/integration/**/*.test.ts", "src/**/*.test.ts"],
    globalSetup: ["test/integration/global-setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    pool: "forks",
  },
});
