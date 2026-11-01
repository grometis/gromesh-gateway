import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// These filesystem/contract/fake-HTTP tests must never start the database setup.
const pureIntegrationTests = [
  "test/integration/environment-roles-contract.test.ts",
  "test/integration/environment-scope-contract.test.ts",
  "test/integration/export-import-contract.test.ts",
  "test/integration/import-hashed-basic-auth-contract.test.ts",
  "test/integration/observability-init.test.ts",
  "test/integration/retention-acceptance-clock.test.ts",
  "test/integration/route-analytics-retention-contract.test.ts",
  "test/integration/session-exempt-routes.test.ts",
  "test/integration/workspace-draft-writes-contract.test.ts",
];

// SWC emits decorator metadata, which Nest's dependency injection needs (esbuild does not).
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: {
    testTimeout: 20_000,
    hookTimeout: 30_000,
    pool: "forks",
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["src/**/*.test.ts", ...pureIntegrationTests] },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          exclude: pureIntegrationTests,
          globalSetup: ["test/integration/global-setup.ts"],
        },
      },
    ],
  },
});
