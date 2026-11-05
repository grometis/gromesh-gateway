import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../src/db/schema.js";
import { sql } from "drizzle-orm";
import type { Db } from "../../src/db/db.js";
import { AgentGatewayService } from "../../src/agent-gateway/agent-gateway.js";
import { authorizeClusterDelivery, confirmClusterAssociation, revokeClusterAssociation } from "../../src/analytics/cluster-history.js";
import { openTrustedIngestion } from "../../src/analytics/trusted-ingestion.js";
import { copyStorageProxy, phaseBarrier } from "./copy-storage-proxy.js";
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
async function runtime(f: Awaited<ReturnType<typeof clusterHistoryFixture>>, run: (db: Db, role: string, pool: pg.Pool) => Promise<void>) {
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

it.each(["*.*", "gromesh_test*.*"])("rejects a residual wildcard writer %s before creating a fresh database", scope => fixture(async (f, admin, settings) => {
  const legacy = `${settings.databaseName}_legacy`, password = randomBytes(24).toString("hex");
  await admin.command({ query: `CREATE USER ${legacy} IDENTIFIED WITH sha256_password BY '${password}'`, clickhouse_settings: { log_queries: 0 } });
  try {
    await admin.command({ query: `GRANT INSERT ON ${scope} TO ${legacy}` });
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

it("rejects an owning login disguised with SET ROLE while accepting a genuine limited login", () => fixture(async (f, admin, settings) => {
  await provisionTrustedCopyStorage({ db: f.db, ctx, admin, settings, administratorNames: [integrationInputs(process.env).clickhouse.user] });
  await runtime(f, async (db, role) => {
    expect((await readRuntimeCopyStorage(db)).databaseName).toBe(settings.databaseName);
    await f.db.transaction(async tx => {
      await tx.execute(sql.raw(`SET LOCAL ROLE ${role}`));
      await expect(readRuntimeCopyStorage(tx)).rejects.toThrow();
    });
  });
}));

it("keeps writer clients private and persists only authenticated current admissions, preserving retry identity", () => fixture(async (f, admin, settings) => {
  await provisionTrustedCopyStorage({ db: f.db, ctx, admin, settings, administratorNames: [integrationInputs(process.env).clickhouse.user] });
  const producer = await f.registered();
  const auth = await f.db.transaction(tx => authorizeClusterDelivery(tx, producer.ctx, producer.source));
  await confirmClusterAssociation(f.db, auth);
  await expect(openTrustedIngestion({ db: f.db, gateway: f.h.app.get(AgentGatewayService), settings })).rejects.toThrow();
  await runtime(f, async db => {
    const root = integrationInputs(process.env).clickhouse;
    for (const kind of ["writer", "reader"] as const)
      await expect(openTrustedIngestion({ db, gateway: f.h.app.get(AgentGatewayService), settings: { ...settings, [kind]: { user: root.user, password: root.password } } })).rejects.toThrow();
    const service = await openTrustedIngestion({ db, gateway: f.h.app.get(AgentGatewayService), settings });
    try {
      expect(Object.keys(service).sort()).toEqual(["close", "open", "persist", "prefix", "prepare"]);
      const podUid = randomUUID(), stream = await service.open(producer.token, podUid);
      // Pooled session state cannot replace the authoritative admission counter.
      await db.execute(sql`create temporary table analytics_ingestion_counter(singleton boolean,position bigint)`);
      await db.execute(sql`insert into pg_temp.analytics_ingestion_counter values(true,999)`);
      const requestId = randomBytes(16).toString("hex"), hex = createHash("sha256").update(`${producer.source.clusterId}|${podUid}|${requestId}`).digest("hex").slice(0,32);
      const id = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
      const ts = (await f.h.sql.query<{ ts: string }>(`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ts`)).rows[0]!.ts;
      const copy = { schemaVersion: 1 as const, copyId: randomUUID(), podUid, requestId, event: { id, ts, environmentId: f.instanceId, clusterId: producer.source.clusterId,
        routeId: f.routeId, serviceId: f.serviceId, consumerId: null, method: "GET", path: "/same", status: 200, latencyKongMs: 1, latencyUpstreamMs: null,
        latencyTotalMs: 2, clientIp: "2001:db8::1", requestSize: "9007199254740993", responseSize: "18446744073709551615", retentionDays: 7 } };
      const batch = randomUUID();
      await expect(service.persist("invalid", stream.id, batch, [copy])).rejects.toThrow();
      const receipt = await service.persist(producer.token, stream.id, batch, [copy]);
      expect(receipt).toMatchObject({ status: "persisted", storedCopies: 1, generation: "1" });
      expect(await service.persist(producer.token, stream.id, batch, [copy])).toEqual(receipt);
      await expect(service.persist(producer.token, stream.id, batch, [{ ...copy, event: { ...copy.event, status: 500 } }])).rejects.toThrow();
      const data = client(settings, "reader");
      try { expect(await (await data.query({ query: "SELECT toString(count()) n FROM requests_v2_copies", format: "JSONEachRow" })).json()).toEqual([{ n: "1" }]); }
      finally { await data.close(); }
      await f.db.transaction(tx => revokeClusterAssociation(tx, ctx, producer.source.clusterId, "revoke"));
      await expect(service.persist(producer.token, stream.id, randomUUID(), [copy])).rejects.toThrow();
      expect((await service.prefix()).copiesComplete).toBe(false);
    } finally { await service.close(); }
  });
}));

it("captures caller-owned copies before waiting for admission locks", () => fixture(async (f, admin, settings) => {
  await provisionTrustedCopyStorage({ db: f.db, ctx, admin, settings, administratorNames: [integrationInputs(process.env).clickhouse.user] });
  const producer = await f.registered(), authorization = await f.db.transaction(tx => authorizeClusterDelivery(tx, producer.ctx, producer.source));
  await confirmClusterAssociation(f.db, authorization);
  await runtime(f, async db => {
    const service = await openTrustedIngestion({ db, gateway: f.h.app.get(AgentGatewayService), settings }), blocker = await f.h.sql.connect();
    try {
      const podUid = randomUUID(), stream = await service.open(producer.token, podUid), requestId = randomBytes(16).toString("hex");
      const h = createHash("sha256").update(`${producer.source.clusterId}|${podUid}|${requestId}`).digest("hex").slice(0,32);
      const ts = (await f.h.sql.query<{ts:string}>(`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ts`)).rows[0]!.ts;
      const copies = [{ schemaVersion: 1 as const, copyId: randomUUID(), podUid, requestId, event: {
        id: `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`, ts, environmentId: f.instanceId, clusterId: producer.source.clusterId,
        routeId: f.routeId, serviceId: f.serviceId, consumerId: null, method: "GET", path: "/same", status: 200, latencyKongMs: 1, latencyUpstreamMs: null,
        latencyTotalMs: 2, clientIp: "2001:db8::1", requestSize: "1", responseSize: "2", retentionDays: 7 } }];
      await blocker.query("select pg_advisory_lock(1818,1801)");
      const pending = service.persist(producer.token, stream.id, randomUUID(), copies);
      copies[0]!.event.status = 500;
      await blocker.query("select pg_advisory_unlock(1818,1801)");
      expect(await pending).toMatchObject({status:"persisted"});
      const reader = client(settings,"reader");
      try { expect(await (await reader.query({query:"SELECT status FROM requests_v2_copies",format:"JSONEachRow"})).json()).toEqual([{status:200}]); }
      finally { await reader.close(); }
    } finally { await blocker.query("select pg_advisory_unlock_all()"); blocker.release(); await service.close(); }
  });
}));
it("refuses server-file and process capabilities reachable through predefined PostgreSQL roles", () => fixture(async (f, admin, settings) => {
  await provisionTrustedCopyStorage({ db: f.db, ctx, admin, settings, administratorNames: [integrationInputs(process.env).clickhouse.user] });
  await runtime(f, async (db, role) => {
    for (const capability of ["pg_read_server_files", "pg_write_server_files", "pg_execute_server_program"]) {
      await f.h.sql.query(`GRANT ${capability} TO ${role}`);
      try {
        await expect(readRuntimeCopyStorage(db)).rejects.toThrow();
        await db.transaction(async tx => {
          await tx.execute(sql`create temporary table pg_roles on commit drop as select * from pg_catalog.pg_roles where false`);
          await expect(readRuntimeCopyStorage(tx)).rejects.toThrow();
        });
      }
      finally { await f.h.sql.query(`REVOKE ${capability} FROM ${role}`); }
    }
    expect((await readRuntimeCopyStorage(db)).databaseName).toBe(settings.databaseName);
  });
}));
it("cannot ACK altered content restored after readback but before receipt confirmation", () => fixture(async (f, admin, settings) => {
  await provisionTrustedCopyStorage({ db: f.db, ctx, admin, settings, administratorNames: [integrationInputs(process.env).clickhouse.user] });
  const producer = await f.registered(), authorization = await f.db.transaction(tx => authorizeClusterDelivery(tx, producer.ctx, producer.source));
  await confirmClusterAssociation(f.db, authorization);
  const before = phaseBarrier(), allowInsert = phaseBarrier(), after = phaseBarrier(), allowReceipt = phaseBarrier();
  let armed = false, paused = false, readback = false;
  const proxy = await copyStorageProxy(settings.url, async query => {
    if (!armed) return;
    if (query.includes("FROM requests_v2_copies WHERE id IN")) readback = true;
    if (query.includes("currentUser() AS principal")) {
      if (!paused) { paused = true; before.release(); await allowInsert.promise; }
      else if (readback) { readback = false; after.release(); await allowReceipt.promise; }
    }
  });
  try { await runtime(f, async db => {
    const service = await openTrustedIngestion({ db, gateway: f.h.app.get(AgentGatewayService), settings: { ...settings, url: proxy.url } });
    try {
      const podUid = randomUUID(), stream = await service.open(producer.token, podUid), requestId = randomBytes(16).toString("hex");
      const h = createHash("sha256").update(`${producer.source.clusterId}|${podUid}|${requestId}`).digest("hex").slice(0,32);
      const ts = (await f.h.sql.query<{ts:string}>(`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ts`)).rows[0]!.ts;
      const copy = { schemaVersion: 1 as const, copyId: randomUUID(), podUid, requestId, event: {
        id: `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`, ts, environmentId: f.instanceId, clusterId: producer.source.clusterId,
        routeId: f.routeId, serviceId: f.serviceId, consumerId: null, method: "GET", path: "/same", status: 200, latencyKongMs: 1, latencyUpstreamMs: null,
        latencyTotalMs: 2, clientIp: "2001:db8::1", requestSize: "1", responseSize: "2", retentionDays: 7 } };
      armed = true;
      const outcome = service.persist(producer.token, stream.id, randomUUID(), [copy]).then(value => ({ value, error: null }), error => ({ value: null, error: error as unknown }));
      await before.promise; copy.event.status = 500; allowInsert.release();
      await after.promise; copy.event.status = 200; allowReceipt.release();
      expect((await outcome).error).toBeNull();
      const reader = client(settings,"reader");
      try { expect(await (await reader.query({query:"SELECT status FROM requests_v2_copies",format:"JSONEachRow"})).json()).toEqual([{status:200}]); }
      finally { await reader.close(); }
    } finally { allowInsert.release(); allowReceipt.release(); await service.close(); }
  }); } finally { allowInsert.release(); allowReceipt.release(); await proxy.close(); }
}));
