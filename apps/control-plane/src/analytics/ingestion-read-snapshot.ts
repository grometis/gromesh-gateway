import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { asc, eq, sql } from "drizzle-orm";
import * as schema from "../db/schema.js";
import type { Db, Executor } from "../db/db.js";

/** Session lock precedes BEGIN: a waiting reader must not keep a snapshot from before the writer committed. */
export async function withIngestionReadSnapshot<T>(pool:pg.Pool,read:(db:Db,signal:AbortSignal)=>Promise<T>):Promise<T>{
 const client=await pool.connect();let locked=false,begun=false,destroy=false;
 const signal=AbortSignal.timeout(8000);
 try{
  await client.query("set lock_timeout='1s'");
  await client.query("select pg_advisory_lock_shared(1818,1801)");locked=true;
  await client.query("begin isolation level repeatable read read only");begun=true;
  await client.query("set local statement_timeout='5s'");
  const result=await read(drizzle(client,{schema}),signal);
  if(signal.aborted)throw Error("Ingestion snapshot deadline exceeded");
  const committed=await client.query("commit");begun=false;if(committed.command!=="COMMIT")throw Error("Ingestion read transaction aborted");return result;
 }finally{
  try{if(begun)await client.query("rollback");if(locked)await client.query("select pg_advisory_unlock_shared(1818,1801)");await client.query("reset lock_timeout");}
  catch{destroy=true;}
  client.release(destroy);
 }
}
/** This observes a receipt prefix only; it does NOT prove current CH survival or delivery since Kong. */
export async function readAdmissionPrefix(db:Db){
 const [counter]=await db.select().from(schema.analyticsIngestionCounter).where(eq(schema.analyticsIngestionCounter.singleton,true));
 const rows=await db.select({generation:schema.analyticsIngestionBatches.generation,receipt:schema.analyticsIngestionReceipts.batchId,batchId:schema.analyticsIngestionBatches.id})
  .from(schema.analyticsIngestionBatches).leftJoin(schema.analyticsIngestionReceipts,eq(schema.analyticsIngestionReceipts.batchId,schema.analyticsIngestionBatches.id)).orderBy(asc(schema.analyticsIngestionBatches.generation)).limit(10001);
 if(rows.length>10000)throw Error("Ingestion prefix budget exceeded");
 let through=0n,expected=1n,gap=false;
 for(const row of rows){if(row.generation!==expected)gap=true;expected=row.generation+1n;if(row.receipt&&row.generation===through+1n)through=row.generation;}
 const accepted=counter?.position??0n;if((rows.at(-1)?.generation??0n)!==accepted)gap=true;
 const pending=rows.filter(r=>!r.receipt).map(r=>r.batchId);
 const clock=(await db.execute<{asOf:string}>(sql`select to_char(transaction_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "asOf"`)).rows[0]!.asOf;
 return {acceptedThrough:accepted.toString(),receiptThrough:through.toString(),pendingBatchIds:pending,gapDetected:gap,
  receiptPrefixComplete:!gap&&!pending.length&&through===accepted,asOf:clock,
  copiesComplete:false as const,conflictHistoryComplete:false as const,coherentSnapshot:false as const,deliveryFromKongComplete:false as const};
}

export async function assertAnalyticsReadSnapshot(db:Executor){
 const row=(await db.execute<{isolation:string;readOnly:string}>(sql`select current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as "readOnly"`)).rows[0]!;
 if(!["repeatable read","serializable"].includes(row.isolation)||row.readOnly!=="on")throw Error("Analytics history requires a coherent read-only snapshot");
}
