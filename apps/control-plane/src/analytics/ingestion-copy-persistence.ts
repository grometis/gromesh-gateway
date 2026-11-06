import type { Tx } from "../db/db.js";
import type { IngestionWork } from "./ingestion-workers.js";
import {StorageConsistencyError} from "./storage-consistency.js";
import { BoundedCopyQueries } from "./bounded-copy-queries.js";
import { createHash } from "node:crypto";
import type { CopyObservation,ObservedCopyIdentity } from "./copy-evidence.js";
import type { ClickHouseClient } from "@clickhouse/client";
import type { IngestionCopy } from "./ingestion-admissions.js";
import { encodeRawRequestCopy } from "./request-copy-store.js";
import { decodeStoredIngestionCopy, ingestionWire as wire, ingestionLogicalContent as logicalKey } from "./stored-ingestion-copy.js";
export interface IngestionPersistenceInput {streamId:string;batchId:string;generation:string;copies:readonly IngestionCopy[];asOf:string;admissionProof?:{bearer:string;work:IngestionWork}}
export interface IngestionPersistence {
 persist(input:IngestionPersistenceInput,caller?:AbortSignal):Promise<CopyPersistenceObservation>;
 confirm?(tx:Tx,input:IngestionPersistenceInput):Promise<void>;
}
export interface SyncCopyWitness {readonly kind:"observed-sync-policy-readback-v1";readonly serverId:string;readonly tableId:string;readonly serverVersion:string;readonly insertQueryId:string}
export interface CopyPersistenceObservation {storedCopies:number;expiredCopies:number;observedCopies:ObservedCopyIdentity[];insertQueryId?:string;storageWitness?:SyncCopyWitness}
/** Only negative technical facts escape the reader; no request content is attached to errors. */
export class CopyEvidenceError extends Error {
 constructor(readonly observations: readonly CopyObservation[]) { super("Ingestion persistence is not confirmed"); }
}
const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
const failed=()=>new Error("Ingestion persistence is not confirmed");
/** Only constructed with the dedicated writer/reader. Observation is actual read-back, never a supplied boolean. */
export class IngestionCopyPersistence {
 constructor(private readonly writer:ClickHouseClient,private readonly reader:ClickHouseClient,private readonly context?:{queries:BoundedCopyQueries;writes:BoundedCopyQueries}) {}
 async persist(input:IngestionPersistenceInput,caller?:AbortSignal):Promise<CopyPersistenceObservation> {
  const signal=AbortSignal.any([AbortSignal.timeout(8000),...(caller?[caller]:[])]);
  signal.throwIfAborted();
  let phase="encode";try{
   const now=Date.parse(input.asOf);if(!Number.isFinite(now))throw failed();
   const expected=new Map(input.copies.map(copy=>{
    const {id,...content}=copy.event;if(typeof id!=="string")throw failed();
    const encoded=encodeRawRequestCopy({id,content});
    const expires=Date.parse(content.ts as string)+(content.retentionDays as number)*86400000;
    return [copy.copyId,{copy,encoded,wire:wire(copy),expired:expires<=now}] as const;
   }));
   const live=[...expected.values()].filter(x=>!x.expired);
   const queries=this.context?.queries??new BoundedCopyQueries(this.reader,{},signal);
   const writes=this.context?.writes??queries.withSession(this.writer);
   phase="insert";const inserted=live.length?await writes.insert({table:"requests_v2_copies",format:"JSONEachRow",abort_signal:signal,
    values:live.map(x=>({...x.encoded,ingress_stream_id:input.streamId,ingress_batch_id:input.batchId,ingress_copy_id:x.copy.copyId,ingress_generation:input.generation,ingress_wire:x.wire})),
    clickhouse_settings:{async_insert:0,insert_deduplicate:0}}):undefined;
   phase="readback";const rows=await queries.query(`SELECT id,toString(ts) AS ts,environment_id,cluster_id,service_id,route_id,consumer_id,method,path,status,
    latency_kong_ms,latency_upstream_ms,latency_total_ms,toString(client_ip) AS client_ip,toString(request_size) AS request_size,toString(response_size) AS response_size,retention_days,
    ingress_stream_id,ingress_batch_id,ingress_copy_id,toString(ingress_generation) AS ingress_generation,ingress_wire
    FROM requests_v2_copies WHERE id IN {ids:Array(UUID)} LIMIT 10001`,{ids:[...new Set(input.copies.map(c=>String(c.event.id)))]},10000,true);
   phase="comparison";const seen=new Set<string>(),observedCopies:ObservedCopyIdentity[]=[];
   const witnesses=new Map<string,{values:Set<string>;expires:number;unavailable:boolean}>();
   for(const x of expected.values()){
    const id=String(x.copy.event.id),prior=witnesses.get(id)??{values:new Set<string>(),expires:0,unavailable:false};
    prior.values.add(logicalKey(x.copy));prior.expires=Math.max(prior.expires,Date.parse(x.copy.event.ts as string)+(x.copy.event.retentionDays as number)*86400000);witnesses.set(id,prior);
   }
   for(const value of rows){
    let requestId:unknown;
    try{
     if(!value||typeof value!=="object"||Array.isArray(value))throw failed();
     requestId=(value as Record<string,unknown>).id;
     const observed=decodeStoredIngestionCopy(value as Record<string,unknown>);
     const {copy,streamId:ingress_stream_id,batchId:ingress_batch_id,generation:ingress_generation,wire:ingress_wire}=observed;
     const ingress_copy_id=copy.copyId,id=String(copy.event.id);
     const witness=witnesses.get(id);if(!witness)throw failed();
     const expiry=Date.parse(copy.event.ts as string)+(copy.event.retentionDays as number)*86400000;
     if(expiry>now+7*86400000)throw failed();
     observedCopies.push({batchId:ingress_batch_id,copyId:ingress_copy_id,generation:ingress_generation});
     witness.values.add(logicalKey(copy));witness.expires=Math.max(witness.expires,expiry);
     if(ingress_batch_id===input.batchId){
      const x=expected.get(ingress_copy_id);if(!x||ingress_stream_id!==input.streamId||ingress_generation!==input.generation||ingress_wire!==x.wire)throw failed();seen.add(ingress_copy_id);
     }
    }catch{
     const witness=typeof requestId==="string"?witnesses.get(requestId):undefined;
     if(witness)witness.unavailable=true;else for(const w of witnesses.values())w.unavailable=true;
    }
   }
   for(const x of live)if(!seen.has(x.copy.copyId))witnesses.get(String(x.copy.event.id))!.unavailable=true;
   const observations:CopyObservation[]=[];
   for(const [id,w]of witnesses){
    const hashes=[...new Set([...w.values].map(digest))].sort();
    if(hashes.length>1)observations.push({id,kind:"conflicting-copies",expiresAt:new Date(w.expires).toISOString(),leftHash:hashes[0]!,rightHash:hashes[1]!});
    else if(w.unavailable||w.values.size>1)observations.push({id,kind:"comparison-unavailable",expiresAt:new Date(w.expires).toISOString(),leftHash:hashes[0]!,rightHash:null});
   }
   if(observations.length)throw new CopyEvidenceError(observations);
   if(signal.aborted)throw failed();
   return {storedCopies:live.length,expiredCopies:expected.size-live.length,observedCopies,...(inserted?.executed?{insertQueryId:inserted.query_id}:{})};
  }catch(error){if(error instanceof CopyEvidenceError)throw error;throw new Error(`Ingestion persistence is not confirmed at ${phase}${error instanceof StorageConsistencyError?`: ${error.code}`:""}`);}
 }
}
