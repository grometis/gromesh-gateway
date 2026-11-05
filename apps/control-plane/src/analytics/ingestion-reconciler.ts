import { ProblemException } from "../common/problem.js";
import { IngestionAdmissions,type IngestionCopy } from "./ingestion-admissions.js";
export interface AdmissionRetry {readonly streamId:string;readonly batchId:string;readonly generation:string;readonly copies:readonly IngestionCopy[]}
/** One finite pass with original payload. No hash reconstruction, background retry loop or source-completeness claim. */
export class IngestionReconciler{
 constructor(private readonly admissions:IngestionAdmissions){}
 async run(token:string,jobs:readonly AdmissionRetry[],caller?:AbortSignal){
  if(!Array.isArray(jobs)||jobs.length<1||jobs.length>20||new Set(jobs.map(j=>j.batchId)).size!==jobs.length||Buffer.byteLength(JSON.stringify(jobs))>2*1024*1024)throw Error("Invalid ingestion reconciliation budget");
  const signal=AbortSignal.any([AbortSignal.timeout(8000),...(caller?[caller]:[])]);
  const completed:Awaited<ReturnType<IngestionAdmissions["persist"]>>[]=[];
  for(let index=0;index<jobs.length;index++){
   const job=jobs[index]!;
   try{
    signal.throwIfAborted();
    completed.push(await this.admissions.persist(token,job.streamId,job.batchId,job.copies,{expectedGeneration:job.generation,signal}));
   }catch(error){
    // Finish the in-flight operation/cleanup before returning; a scheduling deadline is not a distributed rollback.
    const reason=signal.aborted?"cancelled":error instanceof ProblemException&&[401,403].includes(error.getStatus())?"unauthorized":error instanceof ProblemException&&error.getStatus()===409?"admission-conflict":"persistence-unconfirmed";
    return {completed,pending:jobs.slice(index).map(j=>({batchId:j.batchId,generation:j.generation})),reason};
   }
  }
  return {completed,pending:[],reason:null};
 }
}
