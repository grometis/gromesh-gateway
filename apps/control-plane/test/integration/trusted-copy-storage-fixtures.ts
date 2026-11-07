import { randomBytes } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../src/db/schema.js";
import type { Db } from "../../src/db/db.js";
import { createClient, ClickHouseLogLevel, type ClickHouseClient } from "@clickhouse/client";
import { expect } from "vitest";
import { clusterHistoryFixture } from "./cluster-history-fixtures.js";
import { integrationInputs } from "../../../../scripts/integration-databases.mjs";
import type { TrustedCopyStorageSettings } from "../../src/analytics/trusted-copy-storage.js";
import { ADMIN_URL } from "./databases.js";
export async function trustedFixture(run: (f: Awaited<ReturnType<typeof clusterHistoryFixture>>, admin: ClickHouseClient, settings: TrustedCopyStorageSettings) => Promise<void>) {
  // ACLs are server-wide: a negative global-wildcard fixture must not race another file's positive audit.
  // The explicit integration URL points at the disposable harness; this lock never protects product writes.
  const authority = new pg.Client({ connectionString: ADMIN_URL });
  await authority.connect();
  await authority.query("select pg_advisory_lock(21121,1)");
  try {
  const f = await clusterHistoryFixture(), input = integrationInputs(process.env).clickhouse;
  const admin = createClient({ url: input.url, username: input.user, password: input.password, log: { level: ClickHouseLogLevel.OFF }, clickhouse_settings: { log_queries: 0 } });
  const name = `gromesh_test_${randomBytes(12).toString("hex")}`;
  const settings: TrustedCopyStorageSettings = { url: input.url, databaseName: name,
    writer: { user: `${name}_w`, password: randomBytes(24).toString("hex") },
    reader: { user: `${name}_r`, password: randomBytes(24).toString("hex") },
    auditor: { user: `${name}_a`, password: randomBytes(24).toString("hex") } };
  // These exact names were absent before this fixture and can only be created by its trusted provisioner.
  const users = [settings.writer.user, settings.reader.user, settings.auditor.user];
  expect(await (await admin.query({ query: "SELECT name FROM system.users WHERE name IN {users:Array(String)}", query_params: { users }, format: "JSONEachRow" })).json()).toEqual([]);
  expect(await (await admin.query({ query: "SELECT name FROM system.databases WHERE name={database:String}", query_params: { database: name }, format: "JSONEachRow" })).json()).toEqual([]);
  try { await run(f, admin, settings); }
  finally {
    await f.close();
    // Only execution-owned databases/users on the already disposable server, never operational names or prefixes.
    await admin.command({ query: `DROP DATABASE IF EXISTS ${name}`, clickhouse_settings: { log_queries: 0 } });
    for (const user of users) await admin.command({ query: `DROP USER IF EXISTS ${user}`, clickhouse_settings: { log_queries: 0 } });
    await admin.close();
  }
  } finally { await authority.end(); }
}
export const trustedContext = { actor: { type: "system" as const, id: "synthetic-storage-provisioner" }, role: "admin" as const, ip: null };
export async function trustedRuntime(f: Awaited<ReturnType<typeof clusterHistoryFixture>>, run: (db: Db, role: string, pool: pg.Pool) => Promise<void>) {
  const role = `r21_${randomBytes(12).toString("hex")}`, password = randomBytes(24).toString("hex");
  await f.h.sql.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  let pool: pg.Pool | undefined;
  try {
    await f.h.sql.query(`GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}; REVOKE INSERT,UPDATE,DELETE ON public.analytics_ingestion_storage FROM ${role}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    const url = new URL(f.url); url.username = role; url.password = password;
    pool = new pg.Pool({ connectionString: url.toString() });
    await run(drizzle(pool, { schema }), role, pool);
  } finally {
    await pool?.end();
    await f.h.sql.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
  }
}
export function trustedClient(settings: TrustedCopyStorageSettings, kind: "writer" | "reader" | "auditor") {
  return createClient({ url: settings.url, database: settings.databaseName, username: settings[kind].user, password: settings[kind].password, log: { level: ClickHouseLogLevel.OFF }, clickhouse_settings: { log_queries: 0 } });
}
