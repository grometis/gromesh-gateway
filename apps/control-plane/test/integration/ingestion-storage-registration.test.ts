import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { clusterHistoryFixture } from "./cluster-history-fixtures.js";
import { audit } from "../../src/audit/audit.js";

/** Synthetic catalog identities test SQL enforcement only, never storage provenance. */
async function registerSynthetic(f: Awaited<ReturnType<typeof clusterHistoryFixture>>) {
  return f.db.transaction(async tx => {
    const values = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await tx.execute(sql`insert into analytics_ingestion_storage(singleton,instance_id,server_id,database_name,database_id,table_id,definition,writer_id,reader_id,auditor_id,administrator_ids,created_xid)
      values(true,${f.instanceId},${values[0]},'gromesh_test_synthetic',${values[1]},${values[2]},'synthetic SQL-only fixture',${values[3]},${values[4]},${values[5]},ARRAY[${randomUUID()}]::uuid[],pg_current_xact_id()::text)`);
    await audit(tx, { actor: { type: "system", id: "synthetic-storage-registration" }, role: "admin", ip: null },
      { action: "synthetic.storage.registration", entityType: "ingestion-storage" });
  });
}
it("has a dedicated immutable storage registration schema", async () => {
  const f = await clusterHistoryFixture();
  try {
    expect((await f.h.sql.query("select to_regclass('public.analytics_ingestion_storage') name")).rows[0]!.name).toBe("analytics_ingestion_storage");
  } finally { await f.close(); }
});
it("does not allow replacing, deleting or truncating a confirmed resource registration", async () => {
  const f = await clusterHistoryFixture();
  try {
    await registerSynthetic(f);
    await expect(f.h.sql.query("update analytics_ingestion_storage set database_name='replacement'")).rejects.toThrow();
    await expect(f.h.sql.query("delete from analytics_ingestion_storage")).rejects.toThrow();
    await expect(f.h.sql.query("truncate analytics_ingestion_storage")).rejects.toThrow();
    await expect(registerSynthetic(f)).rejects.toThrow();
    expect((await f.h.sql.query("select count(*)::int n from analytics_ingestion_storage")).rows[0]!.n).toBe(1);
  } finally { await f.close(); }
});
it("refuses to manufacture genesis over an already consumed admission position", async () => {
  const f = await clusterHistoryFixture();
  try {
    await f.h.sql.query("insert into analytics_ingestion_counter(singleton,position) values(true,1)");
    await expect(registerSynthetic(f)).rejects.toThrow();
    expect((await f.h.sql.query("select count(*)::int n from analytics_ingestion_storage")).rows[0]!.n).toBe(0);
  } finally { await f.close(); }
});
it("refuses a new genesis after irreversible historical pruning even with a zero counter", async () => {
  const f = await clusterHistoryFixture();
  try {
    await f.h.sql.query("insert into analytics_ingestion_prune_coverage(singleton,pruned_through,pruned_at,prune_transaction) values(true,1,clock_timestamp(),pg_current_xact_id()::text)");
    await expect(registerSynthetic(f)).rejects.toThrow();
    expect((await f.h.sql.query("select count(*)::int n from analytics_ingestion_storage")).rows[0]!.n).toBe(0);
  } finally { await f.close(); }
});
