import { sql } from "drizzle-orm";
import type { Db } from "../db/db.js";
import type { RequestContext } from "../auth/auth.js";
import { audit } from "../audit/audit.js";
/** Seven-day technical comparison horizon; raw payload TTL is never extended or reconstructed. */
export async function pruneAdmissionHistory(db:Db,ctx:RequestContext,limit:number){
 if(!Number.isInteger(limit)||limit<1||limit>1000)throw Error("Invalid admission prune limit");
 return db.transaction(async tx=>{
  await tx.execute(sql`set local lock_timeout='1s'`);await tx.execute(sql`set local statement_timeout='5s'`);
  await tx.execute(sql`select pg_advisory_xact_lock(1818,1801)`);
  const rows=(await tx.execute<{id:string;generation:string}>(sql`
   select b.id,b.generation::text from analytics_ingestion_batches b
   where b.recorded_at<=transaction_timestamp()-interval '168 hours'
    and analytics_ingestion_history_expired(b.descriptor,b.recorded_at,transaction_timestamp())
    and not exists(select 1 from analytics_copy_evidence f where f.source_batch_id=b.id)
    and not exists(select 1 from analytics_ingestion_workers w where w.batch_id=b.id and w.state='persisting' and w.lease_until>transaction_timestamp())
   order by b.recorded_at,b.id limit ${limit} for update of b skip locked`)).rows;
  if(!rows.length)return {removed:0};
  const through=rows.reduce((n,r)=>BigInt(r.generation)>n?BigInt(r.generation):n,0n);
  await tx.execute(sql`insert into analytics_ingestion_prune_coverage(singleton,pruned_through,pruned_at,prune_transaction)
   values(true,${through},clock_timestamp(),pg_current_xact_id()::text)
   on conflict(singleton) do update set pruned_through=greatest(analytics_ingestion_prune_coverage.pruned_through,excluded.pruned_through),pruned_at=excluded.pruned_at,prune_transaction=excluded.prune_transaction`);
  const ids=sql.join(rows.map(r=>sql`${r.id}::uuid`),sql`,`);
  await tx.execute(sql`delete from analytics_ingestion_workers where batch_id in (${ids})`);
  await tx.execute(sql`delete from analytics_ingestion_receipts where batch_id in (${ids})`);
  await tx.execute(sql`delete from analytics_ingestion_batches where id in (${ids})`);
  await audit(tx,ctx,{action:"analytics.ingestion.prune",entityType:"ingestion-history",after:{count:rows.length,prunedThrough:through.toString()}});
  return {removed:rows.length};
 });
}
