import { randomBytes, randomUUID } from "node:crypto";
import { createClient, ClickHouseLogLevel, type ClickHouseClient } from "@clickhouse/client";
import { expect, it } from "vitest";
import { clusterHistoryFixture } from "./cluster-history-fixtures.js";
import { integrationInputs } from "../../../../scripts/integration-databases.mjs";
import { provisionTrustedCopyStorage, type TrustedCopyStorageSettings } from "../../src/analytics/trusted-copy-storage.js";
import { readRuntimeCopyStorage } from "../../src/analytics/ingestion-storage-registration.js";

async function fixture(run: (f: Awaited<ReturnType<typeof clusterHistoryFixture>>, admin: ClickHouseClient, settings: TrustedCopyStorageSettings) => Promise<void>) {
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
}
const ctx = { actor: { type: "system" as const, id: "synthetic-storage-provisioner" }, role: "admin" as const, ip: null };
function client(settings: TrustedCopyStorageSettings, kind: "writer" | "reader" | "auditor") {
  return createClient({ url: settings.url, database: settings.databaseName, username: settings[kind].user, password: settings[kind].password, log: { level: ClickHouseLogLevel.OFF }, clickhouse_settings: { log_queries: 0 } });
}
it("provisions a fresh real resource and enforces separate data/metadata identities", () => fixture(async (f, admin, settings) => {
  const registration = await provisionTrustedCopyStorage({ db: f.db, ctx, admin, settings, administratorNames: [integrationInputs(process.env).clickhouse.user] });
  expect(registration.databaseName).toBe(settings.databaseName);
  expect(new Set([registration.writerId, registration.readerId, registration.auditorId]).size).toBe(3);
  const row = (await f.h.sql.query("select server_id,table_id,database_id from analytics_ingestion_storage")).rows[0]!;
  expect(row).toEqual({ server_id: registration.serverId, table_id: registration.tableId, database_id: registration.databaseId });
  await expect(readRuntimeCopyStorage(f.db)).rejects.toThrow(); // The provisioning owner must never become runtime.
  const reader = client(settings, "reader"), writer = client(settings, "writer"), auditor = client(settings, "auditor");
  try {
    expect(await (await reader.query({ query: "SELECT toString(count()) AS count FROM requests_v2_copies", format: "JSONEachRow" })).json()).toEqual([{ count: "0" }]);
    for (const source of [reader, auditor]) {
      await expect(source.command({ query: "INSERT INTO requests_v2_copies(id) VALUES('00000000-0000-4000-8000-000000000001')" })).rejects.toMatchObject({ code: "497" });
    }
    await expect(writer.query({ query: "SELECT id FROM requests_v2_copies", format: "JSONEachRow" })).rejects.toMatchObject({ code: "497" });
    for (const source of [reader, writer, auditor]) {
      await expect(source.command({ query: "ALTER TABLE requests_v2_copies DELETE WHERE 1" })).rejects.toMatchObject({ code: "497" });
      await expect(source.command({ query: "ALTER TABLE requests_v2_copies ADD COLUMN bypass String" })).rejects.toMatchObject({ code: "497" });
    }
    // Even the dedicated writer cannot accidentally use the raw-copy shape with missing admission identity.
    await expect(writer.insert({ table: "requests_v2_copies", format: "JSONEachRow", values: [{
      id: randomUUID(), ts: "2026-11-05 00:00:00.000", environment_id: f.instanceId, cluster_id: randomUUID(),
      method: "GET", path: "/synthetic", status: 200, client_ip: "2001:db8::1", retention_days: 7,
    }] })).rejects.toMatchObject({ message: expect.stringContaining("admitted_envelope") });
  } finally { await Promise.all([reader.close(), writer.close(), auditor.close()]); }
}));

it("does not adopt an existing resource or reset a committed genesis", () => fixture(async (f, admin, settings) => {
  const args = { db: f.db, ctx, admin, settings, administratorNames: [integrationInputs(process.env).clickhouse.user] };
  const first = await provisionTrustedCopyStorage(args);
  await expect(provisionTrustedCopyStorage(args)).rejects.toThrow();
  expect((await f.h.sql.query("select table_id from analytics_ingestion_storage")).rows).toEqual([{ table_id: first.tableId }]);
}));

it("rejects a residual wildcard writer before creating a fresh database", () => fixture(async (f, admin, settings) => {
  const legacy = `${settings.databaseName}_legacy`, password = randomBytes(24).toString("hex");
  await admin.command({ query: `CREATE USER ${legacy} IDENTIFIED WITH sha256_password BY '${password}'`, clickhouse_settings: { log_queries: 0 } });
  try {
    await admin.command({ query: `GRANT INSERT ON *.* TO ${legacy}` });
    await expect(provisionTrustedCopyStorage({ db: f.db, ctx, admin, settings, administratorNames: [integrationInputs(process.env).clickhouse.user] })).rejects.toThrow();
    expect(await (await admin.query({ query: "SELECT name FROM system.databases WHERE name={database:String}", query_params: { database: settings.databaseName }, format: "JSONEachRow" })).json()).toEqual([]);
    expect((await f.h.sql.query("select count(*)::int n from analytics_ingestion_storage")).rows[0]!.n).toBe(0);
  } finally { await admin.command({ query: `DROP USER ${legacy}` }); }
}));

it("does not provision a resource over a consumed PostgreSQL namespace", () => fixture(async (f, admin, settings) => {
  await f.h.sql.query("insert into analytics_ingestion_counter(singleton,position) values(true,1)");
  await expect(provisionTrustedCopyStorage({ db: f.db, ctx, admin, settings, administratorNames: [integrationInputs(process.env).clickhouse.user] })).rejects.toThrow();
  expect(await (await admin.query({ query: "SELECT name FROM system.databases WHERE name={database:String}", query_params: { database: settings.databaseName }, format: "JSONEachRow" })).json()).toEqual([]);
}));
