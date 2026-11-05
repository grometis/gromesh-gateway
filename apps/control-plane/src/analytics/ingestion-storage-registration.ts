import { sql } from "drizzle-orm";
import type { Db, Executor } from "../db/db.js";
import type { RequestContext } from "../auth/auth.js";
import { audit } from "../audit/audit.js";
import { analyticsIngestionStorage as storage, instance } from "../db/schema.js";
import { copyReadNotReady } from "./bounded-copy-queries.js";
import type { RegisteredCopyStorage } from "./copy-storage-authority-observer.js";

export async function assertUnusedCopyStorageNamespace(tx: Executor) {
  const row = (await tx.execute<{ unused: boolean }>(sql`select public.analytics_ingestion_storage_is_unused() unused`)).rows[0];
  if (row?.unused !== true) throw copyReadNotReady();
}
export async function registerCopyStorage(db: Db, ctx: RequestContext, observed: RegisteredCopyStorage, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (ctx.role !== "admin") throw copyReadNotReady();
  return db.transaction(async tx => {
    await tx.execute(sql`set local search_path=public,pg_temp`);
    await tx.execute(sql`set local lock_timeout='1s'`);
    await tx.execute(sql`set local statement_timeout='5s'`);
    await tx.execute(sql`select pg_advisory_xact_lock(1818,1801)`);
    await assertUnusedCopyStorageNamespace(tx);
    const identities = await tx.select({ id: instance.id }).from(instance).limit(2);
    if (identities.length !== 1 || identities[0]!.id !== observed.instanceId) throw copyReadNotReady();
    const [row] = await tx.insert(storage).values({ ...observed, administratorIds: [...observed.administratorIds], instanceId: identities[0]!.id, createdXid: sql`pg_current_xact_id()::text` }).returning();
    if (!row) throw copyReadNotReady();
    await audit(tx, ctx, { action: "analytics.ingestion.storage.register", entityType: "ingestion-storage", entityId: row.instanceId,
      after: { serverId: row.serverId, databaseId: row.databaseId, tableId: row.tableId, writerId: row.writerId, readerId: row.readerId, auditorId: row.auditorId, administratorIds: row.administratorIds } });
    signal?.throwIfAborted();return row;
  });
}
/** Runtime may read the binding but cannot reset it, own it, or assume an owning role. */
export async function readRuntimeCopyStorage(tx: Executor): Promise<RegisteredCopyStorage> {
  const [row] = (await tx.execute<{ privileged: boolean; owning: boolean; writable: boolean; readable: boolean }>(sql`
    select (session_user<>current_user or exists(select 1 from pg_catalog.pg_roles where
      (rolsuper or rolcreaterole or rolcreatedb or rolreplication or rolbypassrls
        or rolname in ('pg_read_server_files','pg_write_server_files','pg_execute_server_program')
        or pg_catalog.has_schema_privilege(oid,'public','CREATE'))
      and pg_catalog.pg_has_role(session_user,oid,'MEMBER'))) privileged,
      (pg_catalog.pg_has_role(current_user,(select relowner from pg_catalog.pg_class where oid='public.analytics_ingestion_storage'::pg_catalog.regclass),'MEMBER')
       or pg_catalog.pg_has_role(session_user,(select nspowner from pg_catalog.pg_namespace where nspname='public'),'MEMBER')
       or pg_catalog.pg_has_role(session_user,(select datdba from pg_catalog.pg_database where datname=pg_catalog.current_database()),'MEMBER')) owning,
      pg_catalog.has_table_privilege(current_user,'public.analytics_ingestion_storage','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') writable,
      pg_catalog.has_table_privilege(current_user,'public.analytics_ingestion_storage','SELECT') readable`)).rows;
  if (!row || row.privileged !== false || row.owning !== false || row.writable !== false || row.readable !== true) throw copyReadNotReady();
  const registrations = (await tx.execute<typeof storage.$inferSelect>(sql`
    select singleton,instance_id as "instanceId",server_id as "serverId",database_name as "databaseName",database_id as "databaseId",
      table_id as "tableId",definition,writer_id as "writerId",reader_id as "readerId",auditor_id as "auditorId",administrator_ids as "administratorIds",
      created_at::text as "createdAt",created_xid as "createdXid" from public.analytics_ingestion_storage limit 2`)).rows;
  if (registrations.length !== 1) throw copyReadNotReady();
  return registrations[0]!;
}
