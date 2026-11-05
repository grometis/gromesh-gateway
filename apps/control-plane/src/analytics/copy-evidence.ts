import { assertAnalyticsReadSnapshot } from "./ingestion-read-snapshot.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db, Tx, Executor } from "../db/db.js";
import type { RequestContext } from "../auth/auth.js";
import { audit } from "../audit/audit.js";
import { analyticsCopyEvidence as facts, analyticsCopyCoverage as coverage, analyticsIngestionBatches as batches } from "../db/schema.js";

export interface CopyObservation {
  id: string;
  kind: "conflicting-copies" | "comparison-unavailable";
  expiresAt: string;
  leftHash: string;
  rightHash: string | null;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const invalid = (): never => { throw new Error("Invalid copy evidence"); };
async function lock(tx: Tx) {
  await tx.execute(sql`set local lock_timeout='1s'`);
  await tx.execute(sql`set local statement_timeout='5s'`);
  await tx.execute(sql`select pg_advisory_xact_lock(1818,1801)`);
}
/** Internal negative observer only. Hash inequality proves difference; equality never proves equivalence. */
export async function recordCopyEvidence(db: Db, ctx: RequestContext, batchId: string, observations: readonly CopyObservation[]) {
  if (!uuid.test(batchId) || observations.length > 100 || observations.some(o => !uuid.test(o.id) || !hash.test(o.leftHash) || !Number.isFinite(Date.parse(o.expiresAt)) ||
    (o.kind === "conflicting-copies" ? !o.rightHash || !hash.test(o.rightHash) || o.leftHash === o.rightHash : o.kind !== "comparison-unavailable" || o.rightHash !== null))) return invalid();
  return db.transaction(async tx => {
    await lock(tx);
    return recordCopyEvidenceTx(tx,ctx,batchId,observations);
  });
}
async function recordCopyEvidenceTx(tx:Tx,ctx:RequestContext,batchId:string,observations:readonly CopyObservation[]){
    const [source] = await tx.select().from(batches).where(eq(batches.id, batchId));
    if (!source) return invalid();
    const [lost] = await tx.select().from(coverage);
    const ids=[...new Set(observations.map(o=>o.id))];
    const admitted=ids.length?(await tx.execute<{id:string;expiresAt:string}>(sql`select d->>'id' as id,d->>'expiresAt' as "expiresAt" from analytics_ingestion_batches b cross join lateral jsonb_array_elements(b.descriptor) d where d->>'id' in (${sql.join(ids.map(id=>sql`${id}`),sql`,`)}) limit 10001`)).rows:[];
    if(admitted.length>10000)throw new Error("Copy evidence budget exceeded");
    let inserted = 0;
    for (const o of observations) {
      const descriptors = source.descriptor.filter(d => d.id === o.id);
      if (!descriptors.length || Date.parse(o.expiresAt) < Math.max(...descriptors.map(d => Date.parse(d.expiresAt)))) return invalid();
      // A delayed observer also covers copies admitted before its observation committed.
      const expiresAt=new Date(Math.max(Date.parse(o.expiresAt),...admitted.filter(d=>d.id===o.id).map(d=>Date.parse(d.expiresAt)))).toISOString();
      // A replay must not repopulate already pruned, expired evidence. The loss marker remains sticky.
      if (lost?.prunedAt && source.generation <= lost.prunedThrough && Date.parse(expiresAt) <= Date.parse(lost.prunedAt)) continue;
      const pair = o.rightHash ? [o.leftHash, o.rightHash].sort() : [o.leftHash, ""];
      const rows = await tx.insert(facts).values({requestId:o.id,sourceBatchId:batchId,generation:source.generation,kind:o.kind,leftHash:pair[0]!,rightHash:pair[1]!,expiresAt})
        .onConflictDoNothing({target:[facts.sourceBatchId,facts.requestId,facts.kind,facts.leftHash,facts.rightHash,facts.expiresAt]}).returning({id:facts.id});
      inserted += rows.length;
    }
    if (inserted) await audit(tx,ctx,{action:"analytics.copy-evidence.record",entityType:"ingestion-batch",entityId:batchId,after:{count:inserted,generation:source.generation.toString()}});
    return {inserted};
}
/** Admission and extension commit atomically, even when older raw witnesses are gone. */
export async function extendAdmittedCopyEvidence(tx:Tx,ctx:RequestContext,batchId:string){
  const [source]=await tx.select().from(batches).where(eq(batches.id,batchId));if(!source)return invalid();
  const ids=[...new Set(source.descriptor.map(d=>d.id))];
  const existing=await tx.select().from(facts).where(inArray(facts.requestId,ids)).limit(10001);
  if(existing.length>10000)throw new Error("Copy evidence budget exceeded");
  const observations:CopyObservation[]=[];
  for(const id of ids){
    const descriptors=source.descriptor.filter(d=>d.id===id),expiry=Math.max(...descriptors.map(d=>Date.parse(d.expiresAt)));
    const previous=existing.filter(r=>r.requestId===id),conflict=previous.find(r=>r.kind==="conflicting-copies"),negative=conflict??previous[0];
    if(negative&&expiry>Math.max(...previous.map(r=>Date.parse(r.expiresAt)))) observations.push({id,kind:negative.kind,leftHash:negative.leftHash,rightHash:negative.rightHash||null,expiresAt:new Date(expiry).toISOString()});

  }
  return recordCopyEvidenceTx(tx,ctx,batchId,observations);
}
/** Retains expired negatives until physical pruning; callers must evaluate their original retention. */
export async function readCopyEvidence(db: Db, ids: readonly string[]): Promise<{items:CopyObservation[];historyPruned:boolean}> {
  if (ids.length > 200 || ids.some(id => !uuid.test(id))) return invalid();
  return db.transaction(tx=>readCopyEvidenceSnapshot(tx,ids),{isolationLevel:"repeatable read",accessMode:"read only"});
}
/** Caller supplies an already coherent read snapshot. */
export async function readCopyEvidenceSnapshot(tx:Executor,ids:readonly string[]):Promise<{items:CopyObservation[];historyPruned:boolean}>{
  await assertAnalyticsReadSnapshot(tx);
  if(ids.length>200||ids.some(id=>!uuid.test(id)))return invalid();
    await tx.execute(sql`set local statement_timeout='5s'`);
    const [lost] = await tx.select().from(coverage);
    const rows = ids.length ? await tx.select().from(facts).where(inArray(facts.requestId,[...new Set(ids)])).orderBy(asc(facts.requestId),asc(facts.id)).limit(10001) : [];
    if (rows.length > 10000) throw new Error("Copy evidence budget exceeded");
    const items = new Map<string,CopyObservation>();
    for (const row of rows) {
      const previous = items.get(row.requestId);
      const expiresAt = new Date(Math.max(Date.parse(row.expiresAt),previous ? Date.parse(previous.expiresAt) : 0)).toISOString();
      if (previous?.kind === "conflicting-copies" && row.kind !== "conflicting-copies") { previous.expiresAt=expiresAt; continue; }
      items.set(row.requestId,{id:row.requestId,kind:row.kind,expiresAt,leftHash:row.leftHash,rightHash:row.rightHash || null});
    }
    return {items:[...items.values()],historyPruned:(lost?.prunedThrough ?? 0n)>0n};
}
/** Bounded GC records irreversible loss in the same transaction, never converting a gap to a clean history. */
export async function pruneCopyEvidence(db: Db, ctx: RequestContext, limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return invalid();
  return db.transaction(async tx => {
    await lock(tx);
    const expired = await tx.select().from(facts).where(sql`${facts.expiresAt}<=clock_timestamp()`).orderBy(asc(facts.expiresAt),asc(facts.id)).limit(limit).for("update",{skipLocked:true});
    if (!expired.length) return {removed:0};
    const through = expired.reduce((max,row)=>row.generation>max?row.generation:max,0n);
    await tx.insert(coverage).values({singleton:true,prunedThrough:through,prunedAt:sql`clock_timestamp()`,pruneTransaction:sql`pg_current_xact_id()::text`})
      .onConflictDoUpdate({target:coverage.singleton,set:{prunedThrough:sql`greatest(${coverage.prunedThrough},${through})`,prunedAt:sql`clock_timestamp()`,pruneTransaction:sql`pg_current_xact_id()::text`}});
    await tx.delete(facts).where(and(inArray(facts.id,expired.map(r=>r.id)),sql`${facts.expiresAt}<=clock_timestamp()`));
    await audit(tx,ctx,{action:"analytics.copy-evidence.prune",entityType:"copy-evidence",after:{count:expired.length,prunedThrough:through.toString()}});
    return {removed:expired.length};
  });
}

export interface ObservedCopyIdentity {batchId:string;copyId:string;generation:string}
/** Negative-only reconciliation, under the same writer lock as receipt/admission. Never equate hashes. */
export async function reconcileAdmittedComparisons(tx:Tx,ctx:RequestContext,batchId:string,observed:readonly ObservedCopyIdentity[]){
 const [source]=await tx.select().from(batches).where(eq(batches.id,batchId));if(!source||observed.length>10000)return invalid();
 const ids=[...new Set(source.descriptor.map(d=>d.id))];
 const earlier=(await tx.execute<{batchId:string;generation:string;id:string;copyId:string;commitment:string;expiresAt:string}>(sql`
  select b.id as "batchId",b.generation::text as generation,d->>'id' as id,d->>'copyId' as "copyId",d->>'commitment' as commitment,d->>'expiresAt' as "expiresAt"
  from analytics_ingestion_batches b cross join lateral jsonb_array_elements(b.descriptor) d
  where b.generation<${source.generation} and d->>'id' in (${sql.join(ids.map(id=>sql`${id}`),sql`,`)}) limit 10001`)).rows;
 if(earlier.length>10000)throw new Error("Copy comparison budget exceeded");
 const present=new Set(observed.map(o=>JSON.stringify([o.batchId,o.generation,o.copyId]))),observations:CopyObservation[]=[];
 for(const id of ids){
  const admitted=source.descriptor.filter(d=>d.id===id),previous=earlier.filter(d=>d.id===id);
  const differing=previous.find(old=>old.commitment!==admitted[0]!.commitment);
  const missing=previous.some(old=>!present.has(JSON.stringify([old.batchId,old.generation,old.copyId])));
  if(differing||missing)observations.push({id,kind:differing?"conflicting-copies":"comparison-unavailable",leftHash:admitted[0]!.commitment,rightHash:differing?.commitment??null,expiresAt:new Date(Math.max(...admitted.map(d=>Date.parse(d.expiresAt)),...previous.map(d=>Date.parse(d.expiresAt)))).toISOString()});
 }
 await recordCopyEvidenceTx(tx,ctx,batchId,observations);
 // Previously known uncertainty cannot disappear just because its raw witness no longer appears today.
 const negatives=await tx.select({id:facts.id}).from(facts).where(and(inArray(facts.requestId,ids),eq(facts.kind,"conflicting-copies"))).limit(1);
 // A historical individual-batch receipt is not a claim that globally pruned history is complete.
 return {blocked:observations.length>0||negatives.length>0};
}
