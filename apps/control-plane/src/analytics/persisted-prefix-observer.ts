import type pg from "pg";
import { asc,eq } from "drizzle-orm";
import type { Db } from "../db/db.js";
import { analyticsIngestionBatches as batches,analyticsIngestionStreams as streams,analyticsIngestionReceipts as receipts,analyticsIngestionWorkers as workers } from "../db/schema.js";
import { readAdmissionPrefix,withIngestionReadFence } from "./ingestion-read-snapshot.js";
import { readCopyEvidenceSnapshot } from "./copy-evidence.js";
import { decodeStoredIngestionCopy,ingestionLogicalContent } from "./stored-ingestion-copy.js";
import { PhysicalCopyFence } from "./physical-copy-fence.js";
import { copyReadNotReady } from "./bounded-copy-queries.js";
import { StorageConsistencyError } from "./storage-consistency.js";
const exceeded=()=>new StorageConsistencyError("analytics-budget-exceeded","Ingestion prefix observation budget exceeded");
export async function planPersistedPrefix(db:Db){
 const prefix=await readAdmissionPrefix(db);if(!prefix.receiptPrefixComplete)throw copyReadNotReady();
 const rows=await db.select({batchId:batches.id,streamId:batches.streamId,generation:batches.generation,descriptor:batches.descriptor,
  instanceId:streams.instanceId,clusterId:streams.clusterId,podUid:streams.podUid,authorizationId:streams.authorizationId,
  receipt:receipts.batchId,storedCopies:receipts.storedCopies,expiredCopies:receipts.expiredCopies,workerState:workers.state,workerEpoch:workers.epoch,workerToken:workers.token})
  .from(batches).innerJoin(streams,eq(streams.id,batches.streamId)).leftJoin(receipts,eq(receipts.batchId,batches.id)).leftJoin(workers,eq(workers.batchId,batches.id)).orderBy(asc(batches.generation)).limit(101);
 if(rows.length>100)throw exceeded();
 let next=1n,copies=0;
 for(const row of rows){
  if(row.generation!==next++||!row.receipt||row.workerState!=="verified"||!row.workerEpoch||!row.workerToken||row.expiredCopies!==0||row.storedCopies!==row.descriptor.length)throw copyReadNotReady();
  copies+=row.descriptor.length;
 }
 if((rows.at(-1)?.generation??0n).toString()!==prefix.acceptedThrough)throw copyReadNotReady();
 const ids=[...new Set(rows.flatMap(r=>r.descriptor.map(d=>d.id)))];if(ids.length>200||copies>10000)throw exceeded();
 return {through:prefix.acceptedThrough,rows:rows.map(r=>({...r,generation:r.generation.toString(),workerEpoch:r.workerEpoch!.toString()})),ids,copies};
}
export async function validatePersistedPrefix(db:Db,prepared:Awaited<ReturnType<typeof planPersistedPrefix>>,observed:Awaited<ReturnType<PhysicalCopyFence["observe"]>>) {
   const current=await planPersistedPrefix(db);
   if(JSON.stringify(prepared)!==JSON.stringify(current))throw copyReadNotReady();
   // Metadata, negative facts and final planning data come from THIS coherent PostgreSQL snapshot.
   const negative=await readCopyEvidenceSnapshot(db,current.ids);if(negative.historyPruned||negative.items.length)throw copyReadNotReady();
   const decodedCopies:ReturnType<typeof decodeStoredIngestionCopy>[]=[];
   const byBatch=new Map(current.rows.map(r=>[r.batchId,r])),seen=new Set<string>(),content=new Map<string,string>();
   const prefix=await readAdmissionPrefix(db);const now=Date.parse(prefix.asOf);
   for(const row of observed.rows){
    let value:ReturnType<typeof decodeStoredIngestionCopy>;try{value=decodeStoredIngestionCopy(row);}catch{throw copyReadNotReady();}
    decodedCopies.push(value);
    const admission=byBatch.get(value.batchId),id=String(value.copy.event.id);
    if(!admission||admission.streamId!==value.streamId||admission.generation!==value.generation||admission.instanceId!==value.copy.event.environmentId||admission.clusterId!==value.copy.event.clusterId||admission.podUid!==value.copy.podUid)throw copyReadNotReady();
    const descriptor=admission.descriptor.find(d=>d.copyId===value.copy.copyId);
    if(!descriptor||descriptor.id!==id||descriptor.commitment!==value.commitment||descriptor.expiresAt!==value.expiresAt||Date.parse(value.expiresAt)<=now)throw copyReadNotReady();
    const logical=ingestionLogicalContent(value.copy);if(content.has(id)&&content.get(id)!==logical)throw copyReadNotReady();content.set(id,logical);
    seen.add(JSON.stringify([value.batchId,value.generation,value.copy.copyId]));
   }
   for(const admission of current.rows)for(const d of admission.descriptor)if(!seen.has(JSON.stringify([admission.batchId,admission.generation,d.copyId]))||Date.parse(d.expiresAt)<=now)throw copyReadNotReady();
   return {current,copies:decodedCopies,asOf:prefix.asOf};
}

/** Current physical observation of a bounded admitted prefix. No reusable serving token is minted. */
export class PersistedPrefixObserver {
 constructor(private readonly pool:pg.Pool,private readonly physical:PhysicalCopyFence){}
 observe(signal?:AbortSignal){
  return withIngestionReadFence(this.pool,planPersistedPrefix,(p,signal)=>this.physical.observe(p.ids,{},signal),async(db,prepared,observed)=>{
   const {current}=await validatePersistedPrefix(db,prepared,observed);
   return {observedThrough:current.through,copiesCompared:current.copies,physical:{tableId:observed.tableId,parts:observed.parts},usage:observed.usage,
    // A stable part cut does not prove power-loss durability, future survival, or delivery before admission.
    proof:{copiesComplete:false as const,conflictHistoryComplete:false as const,coherentSnapshot:false as const,deliveryFromKongComplete:false as const}};
  },signal);
 }
}
