import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import { AgentGatewayService } from "../agent-gateway/agent-gateway.js";
import { IngestionCopyPersistence } from "./ingestion-copy-persistence.js";
import { ProblemException } from "../common/problem.js";
import { IngestionAdmissions,type IngestionCopy } from "./ingestion-admissions.js";
export interface AdmissionRetry {readonly streamId:string;readonly batchId:string;readonly generation:string;readonly copies:readonly IngestionCopy[]}
/** Preserve the source identity, but remove DSN precedence over the dedicated client's budgets. */
export function reconciliationPoolConfig(source:pg.Pool):pg.PoolConfig{
 const config:pg.PoolConfig={...source.options,password:source.options.password,max:1,connectionTimeoutMillis:1000,statement_timeout:5000,query_timeout:6000,idle_in_transaction_session_timeout:5000};
 if(source.options.options?.trim())throw Error("Unsupported reconciliation connection options");
 if(config.connectionString){
  const url=new URL(config.connectionString);if(!["postgres:","postgresql:"].includes(url.protocol)||url.searchParams.get("options")?.trim())throw Error("Unsupported reconciliation connection options");
  for(const [key,value]of Object.entries({statement_timeout:"5000",query_timeout:"6000",idle_in_transaction_session_timeout:"5000",options:"-c lock_timeout=1000"}))url.searchParams.set(key,value);
  config.connectionString=url.toString();
 }
 config.options="-c lock_timeout=1000";return config;
}
/** One finite pass with original payload. No hash reconstruction, background retry loop or source-completeness claim. */
export class IngestionReconciler{
 constructor(private readonly sourcePool:pg.Pool,private readonly gateway:AgentGatewayService,private readonly persistence:IngestionCopyPersistence){}
 async run(token:string,jobs:readonly AdmissionRetry[],caller?:AbortSignal){
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if(!Array.isArray(jobs)||jobs.length<1||jobs.length>20||jobs.some(j=>!j||typeof j!=="object"||typeof j.streamId!=="string"||!uuid.test(j.streamId)||typeof j.batchId!=="string"||!uuid.test(j.batchId)||typeof j.generation!=="string"||!/^[1-9][0-9]{0,18}$/.test(j.generation)||BigInt(j.generation)>9223372036854775807n||!Array.isArray(j.copies)||j.copies.length<1||j.copies.length>100)||new Set(jobs.map(j=>j.batchId)).size!==jobs.length||Buffer.byteLength(JSON.stringify(jobs))>2*1024*1024)throw Error("Invalid ingestion reconciliation budget");
  const signal=AbortSignal.any([AbortSignal.timeout(8000),...(caller?[caller]:[])]);
  // A dedicated bounded pool covers even nontransactional probes and pool acquisition; the operational pool is untouched.
  const pool=new pg.Pool(reconciliationPoolConfig(this.sourcePool));
  const admissions=new IngestionAdmissions(drizzle(pool,{schema}),this.gateway,this.persistence);
  try{
  const completed:Awaited<ReturnType<IngestionAdmissions["persist"]>>[]=[];
  for(let index=0;index<jobs.length;index++){
   const job=jobs[index]!;
   try{
    signal.throwIfAborted();
    completed.push(await admissions.persist(token,job.streamId,job.batchId,job.copies,{expectedGeneration:job.generation,signal}));
   }catch(error){
    // Finish the in-flight operation/cleanup before returning; a scheduling deadline is not a distributed rollback.
    const reason=signal.aborted?"cancelled":error instanceof ProblemException&&[401,403].includes(error.getStatus())?"unauthorized":error instanceof ProblemException&&error.getStatus()===409?"admission-conflict":"persistence-unconfirmed";
    return {completed,pending:jobs.slice(index).map(j=>({batchId:j.batchId,generation:j.generation})),reason};
   }
  }
  return {completed,pending:[],reason:null};
  }finally{await pool.end();}
 }
}
