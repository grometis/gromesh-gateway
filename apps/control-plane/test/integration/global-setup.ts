import { readFileSync } from "node:fs";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { clickhouseInputs, createPostgresSandbox, provisionClickhouse, type ClickhouseConfig } from "../../../../scripts/integration-databases.mjs";
import { runMigrations } from "../../src/db/migrate.js";

/** The base connection only issues CREATE/DROP DATABASE, never fixture or migration SQL. */
export default async function setup({ provide }: TestProject) {
  // Validate forbidden ClickHouse overrides before the first connection, including PostgreSQL.
  const clickhouseAdmin = clickhouseInputs(process.env);
  const adminUrl = process.env.TEST_DATABASE_URL ?? "postgres://gromesh:gromesh@127.0.0.1:5432/gromesh";
  const postgres = createPostgresSandbox(adminUrl, async (connectionString) => {
    const client = new pg.Client({ connectionString });
    await client.connect();
    return client;
  });
  const dbName = postgres.name();
  let clickhouse: Awaited<ReturnType<typeof provisionClickhouse>> | undefined;
  const close = async () => {
    const results = await Promise.allSettled([clickhouse?.close(), postgres.drop(dbName)]);
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason as unknown);
    if (errors.length) throw new AggregateError(errors, "Integration database cleanup failed");
  };
  try {
    const databaseUrl = await postgres.create(dbName);
    await runMigrations(postgres.assertOwned(databaseUrl));
    const ddl = ["001-requests.sql", "002-retention.sql"].map((name) => readFileSync(new URL(`../../../../deploy/observability/clickhouse/${name}`, import.meta.url), "utf8")).join("\n");
    clickhouse = await provisionClickhouse(clickhouseAdmin, ddl);
    provide("databaseUrl", databaseUrl);
    provide("databaseAdminUrl", adminUrl);
    provide("clickhouse", clickhouse.reader);
    provide("clickhouseWriter", clickhouse.writer);
    return close;
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Integration database setup and cleanup failed"); }
    throw error;
  }
}

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
    databaseAdminUrl: string;
    clickhouse: ClickhouseConfig;
    clickhouseWriter: ClickhouseConfig;
  }
}
