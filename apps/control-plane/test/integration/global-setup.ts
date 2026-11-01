import pg from "pg";
import type { TestProject } from "vitest/node";
import { assertStack } from "../../../../scripts/stack-guard.mjs";
import { runMigrations } from "../../src/db/migrate.js";

/**
 * One throwaway database per test run, migrated from drizzle/.
 * TEST_DATABASE_URL must point at a Postgres where the user can CREATE DATABASE
 * (default: the compose Postgres).
 */
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://gromesh:gromesh@127.0.0.1:5432/gromesh";

export default async function setup({ provide }: TestProject) {
  // An isolated run (GROMESH_STACK_ISOLATED=1) names its Postgres, ClickHouse and validator and owns them.
  await assertStack("integration");
  const dbName = `gromesh_test_${Date.now()}_${process.pid}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  await runMigrations(url.toString());
  provide("databaseUrl", url.toString());

  return async () => {
    const c = new pg.Client({ connectionString: ADMIN_URL });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await c.end();
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}
