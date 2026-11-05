import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../db/db.js";
import type { RequestContext } from "../auth/auth.js";
import { analyticsIngestionWorkers as workers } from "../db/schema.js";
import { audit } from "../audit/audit.js";
import { ProblemException } from "../common/problem.js";
export interface IngestionWork {batchId:string;epoch:bigint;token:string}
const stale=()=>new ProblemException(409,"Ingestion persistence worker is no longer current");
/** Call under the admission lock; all network work occurs after this transaction commits. */
export async function claimIngestionWork(tx:Tx,ctx:RequestContext,batchId:string):Promise<IngestionWork>{
 const token=randomUUID();
 const [claimed]=await tx.insert(workers).values({batchId,epoch:1n,token,state:"persisting",leaseUntil:sql`clock_timestamp()+interval '30 seconds'`})
  .onConflictDoUpdate({target:workers.batchId,set:{epoch:sql`${workers.epoch}+1`,token,state:"persisting",leaseUntil:sql`clock_timestamp()+interval '30 seconds'`},setWhere:sql`${workers.state}='failed' or (${workers.state}='persisting' and ${workers.leaseUntil}<=clock_timestamp())`}).returning();
 if(!claimed)throw stale();
 await audit(tx,ctx,{action:"analytics.ingestion.claim",entityType:"ingestion-batch",entityId:batchId,after:{workerEpoch:claimed.epoch.toString()}});
 return {batchId,epoch:claimed.epoch,token};
}
export async function assertIngestionWork(tx:Tx,work:IngestionWork){
 const [active]=await tx.select().from(workers).where(and(eq(workers.batchId,work.batchId),eq(workers.epoch,work.epoch),eq(workers.token,work.token),eq(workers.state,"persisting"),sql`${workers.leaseUntil}>clock_timestamp()`)).for("update");
 if(!active)throw stale();
}
export async function finishIngestionWork(tx:Tx,ctx:RequestContext,work:IngestionWork,state:"verified"|"failed"){
 const [changed]=await tx.update(workers).set({state}).where(and(eq(workers.batchId,work.batchId),eq(workers.epoch,work.epoch),eq(workers.token,work.token),eq(workers.state,"persisting"),...(state==="verified"?[sql`${workers.leaseUntil}>clock_timestamp()`]:[]))).returning({id:workers.batchId});
 if(!changed){if(state==="verified")throw stale();return;}
 await audit(tx,ctx,{action:`analytics.ingestion.${state}`,entityType:"ingestion-batch",entityId:work.batchId,after:{workerEpoch:work.epoch.toString()}});
}
