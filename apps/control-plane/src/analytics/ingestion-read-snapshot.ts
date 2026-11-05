import pg from "pg";
import {ingestionCancellationConfig} from "./ingestion-cancellation.js";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { asc, eq, sql } from "drizzle-orm";
import * as schema from "../db/schema.js";
import type { Db, Executor } from "../db/db.js";

/** Session lock precedes BEGIN: a waiting reader must not keep a snapshot from before the writer committed. */
type SnapshotRead=<T>(read:(db:Db)=>Promise<T>)=>Promise<T>;
async function withIngestionReadSession<T>(pool:pg.Pool,read:(snapshot:SnapshotRead,signal:AbortSignal)=>Promise<T>,caller?:AbortSignal):Promise<T>{
 const signal=AbortSignal.any([AbortSignal.timeout(8000),...(caller?[caller]:[])]);
 signal.throwIfAborted();
 const client=await new Promise<pg.PoolClient>((resolve,reject)=>{
  const cancel=()=>reject(Error("Ingestion snapshot cancelled"));signal.addEventListener("abort",cancel,{once:true});
  void pool.connect().then(client=>{signal.removeEventListener("abort",cancel);if(signal.aborted){client.release();reject(Error("Ingestion snapshot cancelled"));}else resolve(client);},error=>{signal.removeEventListener("abort",cancel);reject(error);});
 });
 let locked=false,begun=false,released=false,destroy=false,previousName="",pid=0;
 let cancelling:Promise<void>|undefined;
 const name=`gromesh-analytics-read:${randomUUID()}`;
 // Socket loss alone does not interrupt pg_sleep or server work. Terminate ONLY our nonce-bound backend.
 const cancel=()=>{if(!released){released=true;client.release(true);
  cancelling=(async()=>{const control=new pg.Client(ingestionCancellationConfig(pool));
   try{await control.connect();await control.query("select pg_terminate_backend(pid) from pg_stat_activity where pid=$1 and application_name=$2 and usename=current_user and datname=current_database()",[pid,name]);}finally{await control.end();}
  })().catch(()=>undefined);
 }};
 signal.addEventListener("abort",cancel,{once:true});
 try{
  signal.throwIfAborted();
  const backend=(await client.query<{pid:number;name:string}>("select pg_backend_pid() pid,current_setting('application_name') name")).rows[0]!;pid=backend.pid;previousName=backend.name;
  await client.query("select set_config('application_name',$1,false)",[name]);
  await client.query("set lock_timeout='1s'");
  await client.query("select pg_advisory_lock_shared(1818,1801)");locked=true;
  signal.throwIfAborted();
  const snapshot:SnapshotRead=async read=>{
   signal.throwIfAborted();if(begun)throw Error("Nested ingestion snapshot");
   await client.query("begin isolation level repeatable read read only");begun=true;
   await client.query("set local statement_timeout='5s'");
   const result=await read(drizzle(client,{schema}));signal.throwIfAborted();
   const committed=await client.query("commit");begun=false;if(committed.command!=="COMMIT")throw Error("Ingestion read transaction aborted");return result;
  };
  const result=await read(snapshot,signal);signal.throwIfAborted();return result;
 }finally{
  signal.removeEventListener("abort",cancel);
  if(cancelling)await cancelling;
  if(!released){
   try{if(begun)await client.query("rollback");if(locked)await client.query("select pg_advisory_unlock_shared(1818,1801)");await client.query("reset lock_timeout");await client.query("select set_config('application_name',$1,false)",[previousName]);}
   catch{destroy=true;}
   released=true;client.release(destroy);
  }
 }
}

/** Existing readers retain one coherent transaction; the shared session lock always precedes its snapshot. */
export function withIngestionReadSnapshot<T>(pool:pg.Pool,read:(db:Db,signal:AbortSignal)=>Promise<T>,caller?:AbortSignal):Promise<T>{
 return withIngestionReadSession(pool,(snapshot,signal)=>snapshot(db=>read(db,signal)),caller);
}
/** Planning and final validation share the ingestion lock, but ClickHouse I/O runs with NO open PG transaction. */
export function withIngestionReadFence<P,O,T>(pool:pg.Pool,prepare:(db:Db)=>Promise<P>,observe:(plan:P,signal:AbortSignal)=>Promise<O>,confirm:(db:Db,plan:P,observed:O)=>Promise<T>,caller?:AbortSignal):Promise<T>{
 return withIngestionReadSession(pool,async(snapshot,signal)=>{const plan=await snapshot(prepare);const observed=await observe(plan,signal);return snapshot(db=>confirm(db,plan,observed));},caller);
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
