import { createClient, ClickHouseLogLevel, type ClickHouseClient } from "@clickhouse/client";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "../db/db.js";
import type { RequestContext } from "../auth/auth.js";
import { instance } from "../db/schema.js";
import { BoundedCopyQueries, copyReadNotReady } from "./bounded-copy-queries.js";
import { copyStorageColumns, assertCopyStorageSchema } from "./copy-storage-schema.js";
import { evaluateCopyStorageGenesisAccess, type CopyStorageAuthorityPolicy } from "./copy-storage-authority.js";
import { readCopyStorageCatalog, readCopyStorageResource, observeCopyStorageAuthority } from "./copy-storage-authority-observer.js";
import { registerCopyStorage, assertUnusedCopyStorageNamespace } from "./ingestion-storage-registration.js";
import { synchronousCopyResource } from "./sync-copy-persistence.js";
import { StorageConsistencyError } from "./storage-consistency.js";

export interface TrustedCopyStorageLogin { readonly user: string; readonly password: string }
export interface TrustedCopyStorageSettings {
  readonly url: string;
  readonly databaseName: string;
  readonly writer: TrustedCopyStorageLogin;
  readonly reader: TrustedCopyStorageLogin;
  readonly auditor: TrustedCopyStorageLogin;
}
function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw copyReadNotReady();
  return `\`${value}\``;
}
function validateEndpoint(settings: Pick<TrustedCopyStorageSettings,"url"|"databaseName">) {
  try {
    const url = new URL(settings.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw copyReadNotReady();
    if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw copyReadNotReady();
    identifier(settings.databaseName);
    if (["gromesh", "default", "system", "information_schema"].includes(settings.databaseName)) throw copyReadNotReady();
  } catch { throw copyReadNotReady(); }
}
export function validateTrustedCopyStorageSettings(settings: TrustedCopyStorageSettings) {
  validateEndpoint(settings);
  try {
    const names = new Set<string>(), secrets = new Set<string>();
    for (const login of [settings.writer, settings.reader, settings.auditor]) {
      identifier(login.user);
      // New dedicated credentials only; no existing/operational credential is changed or adopted.
      if (names.has(login.user) || secrets.has(login.password) || !/^[0-9a-f]{48,128}$/.test(login.password)) throw copyReadNotReady();
      names.add(login.user); secrets.add(login.password);
    }
  } catch { throw copyReadNotReady(); }
}
export function privateCopyStorageClient(settings: Pick<TrustedCopyStorageSettings,"url"|"databaseName">, login: TrustedCopyStorageLogin, database = settings.databaseName) {
  validateEndpoint(settings);
  return createClient({ url: settings.url, database, username: login.user, password: login.password, request_timeout: 5000,
    max_open_connections: 1, log: { level: ClickHouseLogLevel.OFF }, clickhouse_settings: { log_queries: 0 } });
}
function trustedDdl(database: string) {
  return `CREATE TABLE ${identifier(database)}.requests_v2_copies (${copyStorageColumns.map(([name,type])=>`${identifier(name)} ${type}`).join(",")},
    CONSTRAINT valid_retention CHECK retention_days BETWEEN 1 AND 7,
    CONSTRAINT admitted_envelope CHECK isNotNull(ingress_stream_id) AND isNotNull(ingress_batch_id) AND isNotNull(ingress_copy_id)
      AND isNotNull(ingress_generation) AND ingress_generation>0 AND isNotNull(ingress_wire) AND isValidJSON(ifNull(ingress_wire,'')))
    ENGINE=MergeTree PARTITION BY toDate(ts) ORDER BY (id,ts,environment_id) TTL ts+toIntervalDay(retention_days)
    SETTINGS index_granularity=8192,fsync_after_insert=1,fsync_part_directory=1,min_rows_to_fsync_after_merge=1`;
}

/** Trusted, explicit provisioning only. Never called by AppModule or an HTTP handler.
 * Partial failure leaves an unregistered resource for the operator; it never adopts or deletes an existing object. */
export async function provisionTrustedCopyStorage(input: {
  db: Db; ctx: RequestContext; admin: ClickHouseClient; settings: TrustedCopyStorageSettings; administratorNames: readonly string[]; signal?: AbortSignal;
}) {
  const { db, ctx, admin, settings } = input;
  validateTrustedCopyStorageSettings(settings);
  if (ctx.role !== "admin" || !input.administratorNames.length || input.administratorNames.length > 8 || new Set(input.administratorNames).size !== input.administratorNames.length) throw copyReadNotReady();
  const signal = AbortSignal.any([AbortSignal.timeout(30000), ...(input.signal ? [input.signal] : [])]);
  const clients: ClickHouseClient[] = [];
  let phase = "namespace";
  try {
    const instanceId=await db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout='1s'`);
      await tx.execute(sql`select pg_advisory_xact_lock(1818,1801)`);
      await assertUnusedCopyStorageNamespace(tx);
      const identities=await tx.select({id:instance.id}).from(instance).limit(2);
      if(identities.length!==1)throw copyReadNotReady();return identities[0]!.id;
    });
    signal.throwIfAborted();
    phase="administrator";
    const administrators=await new BoundedCopyQueries(admin,{},signal,`gromesh-provisioner-${randomUUID()}`).query("SELECT currentUser() AS principal,toString(serverUUID()) AS serverId,version() AS version",{},1);
    const administrator=administrators[0];
    if(administrators.length!==1||!administrator||typeof administrator.principal!=="string"||administrator.version!=="25.8.33.6"||!input.administratorNames.includes(administrator.principal))throw copyReadNotReady();
    const command = (query: string) => admin.command({ query, abort_signal: signal, clickhouse_settings: { log_queries: 0, max_execution_time: 5, wait_end_of_query: 1 } });
    phase="users";
    for (const login of [settings.writer, settings.reader, settings.auditor]) await command(`CREATE USER ${identifier(login.user)} IDENTIFIED WITH sha256_password BY '${login.password}'`);
    const table = `${identifier(settings.databaseName)}.requests_v2_copies`, writer = identifier(settings.writer.user), reader = identifier(settings.reader.user), auditor = identifier(settings.auditor.user);
    // Grants may exist before the new resource. This permits auditing all potential writers before CREATE.
    phase="grants";await command(`GRANT INSERT ON ${table} TO ${writer}`);
    await command(`GRANT SELECT ON ${table} TO ${reader}`);
    await command(`GRANT SHOW USERS,SHOW ROLES,SHOW TABLES ON *.* TO ${auditor}`);
    await command(`GRANT SHOW COLUMNS ON ${table} TO ${auditor}`);
    for (const [columns, source] of [
      ["name,id,auth_type", "users"], ["user_name,role_name,access_type,database,table,column,is_partial_revoke,grant_option", "grants"],
      ["user_name,role_name,granted_role_name,with_admin_option", "role_grants"], ["database,name,uuid,engine,engine_full,create_table_query", "tables"], ["name,uuid,engine", "databases"],
    ]) await command(`GRANT SELECT(${columns}) ON system.${source} TO ${auditor}`);
    for (const login of [writer, reader]) {
      await command(`GRANT SELECT(uuid,engine_full,database,name,engine,create_table_query) ON system.tables TO ${login}`);
      await command(`GRANT SELECT(uuid,name,engine) ON system.databases TO ${login}`);
    }
    await command(`GRANT SELECT(name,uuid,rows,bytes_on_disk,data_version,database,table,active) ON system.parts TO ${reader}`);
    phase="preflight";const initial = privateCopyStorageClient(settings, settings.auditor, "default"); clients.push(initial);
    const pre = await readCopyStorageCatalog(new BoundedCopyQueries(initial, {}, signal, `gromesh-genesis-pre-${randomUUID()}`));
    if(pre.serverId!==administrator.serverId)throw copyReadNotReady();
    const byName = new Map(pre.catalog.users.map(row => [String(row.name), String(row.id)]));
    const requiredId = (name: string) => { const id=byName.get(name);if(!id)throw copyReadNotReady();return id; };
    const policy: CopyStorageAuthorityPolicy = { databaseName: settings.databaseName, writerId: requiredId(settings.writer.user), readerId: requiredId(settings.reader.user), auditorId: requiredId(settings.auditor.user), administratorIds: input.administratorNames.map(requiredId) };
    evaluateCopyStorageGenesisAccess(policy, pre.catalog);
    phase="create";await command(`CREATE DATABASE ${identifier(settings.databaseName)} ENGINE=Atomic`);
    await command(trustedDdl(settings.databaseName));
    const observer = privateCopyStorageClient(settings, settings.auditor); clients.push(observer);
    const queries = new BoundedCopyQueries(observer, {}, signal, `gromesh-genesis-post-${randomUUID()}`);
    phase="resource";const resource = await readCopyStorageResource(queries);
    if (resource.serverId !== pre.serverId || resource.databaseName !== settings.databaseName) throw copyReadNotReady();
    phase="policy";synchronousCopyResource({ ...resource, serverVersion: resource.version });
    phase="schema";await assertCopyStorageSchema(queries);
    const registration = { ...policy, instanceId, serverId: resource.serverId, databaseId: resource.databaseId, tableId: resource.tableId, definition: resource.definition };
    phase="authority";await observeCopyStorageAuthority(queries, registration, true);
    signal.throwIfAborted();
    phase="binding";return await registerCopyStorage(db, ctx, registration,signal);
  } catch { throw new StorageConsistencyError("analytics-not-ready",`Trusted storage genesis unavailable at ${phase}`); }
  finally { await Promise.all(clients.map(client => client.close())); }
}
