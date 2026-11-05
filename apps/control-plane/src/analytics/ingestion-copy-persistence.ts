import { createHash } from "node:crypto";
import type { CopyObservation,ObservedCopyIdentity } from "./copy-evidence.js";
import type { ClickHouseClient } from "@clickhouse/client";
import type { IngestionCopy } from "./ingestion-admissions.js";
import { encodeRawRequestCopy } from "./request-copy-store.js";
import { copyStateOf } from "./copy-state.js";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Only negative technical facts escape the reader; no request content is attached to errors. */
export class CopyEvidenceError extends Error {
 constructor(readonly observations: readonly CopyObservation[]) { super("Ingestion persistence is not confirmed"); }
}
const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
const failed=()=>new Error("Ingestion persistence is not confirmed");
const canonicalIp=(value:unknown)=>{if(typeof value!=="string")throw failed();return new URL(`http://[${value}]/`).hostname;};
const wire=(copy:IngestionCopy)=>JSON.stringify({schemaVersion:copy.schemaVersion,copyId:copy.copyId,podUid:copy.podUid,requestId:copy.requestId,event:Object.fromEntries(Object.keys(copy.event).sort().map(k=>[k,copy.event[k]]))});
/** Only constructed with the dedicated writer/reader. Observation is actual read-back, never a supplied boolean. */
export class IngestionCopyPersistence {
 constructor(private readonly writer:ClickHouseClient,private readonly reader:ClickHouseClient) {}
 async persist(input:{streamId:string;batchId:string;generation:string;copies:readonly IngestionCopy[];asOf:string}) {
  const signal=AbortSignal.timeout(8000);
  try{
   const now=Date.parse(input.asOf);if(!Number.isFinite(now))throw failed();
   const expected=new Map(input.copies.map(copy=>{
    const {id,...content}=copy.event;if(typeof id!=="string")throw failed();
    const encoded=encodeRawRequestCopy({id,content});
    const expires=Date.parse(content.ts as string)+(content.retentionDays as number)*86400000;
    return [copy.copyId,{copy,encoded,wire:wire(copy),expired:expires<=now}] as const;
   }));
   const live=[...expected.values()].filter(x=>!x.expired);
   if(live.length)await this.writer.insert({table:"requests_v2_copies",format:"JSONEachRow",abort_signal:signal,
    values:live.map(x=>({...x.encoded,ingress_stream_id:input.streamId,ingress_batch_id:input.batchId,ingress_copy_id:x.copy.copyId,ingress_generation:input.generation,ingress_wire:x.wire})),
    clickhouse_settings:{async_insert:0,insert_deduplicate:0}});
   const result=await this.reader.query({query:`SELECT id,toString(ts) AS ts,environment_id,cluster_id,service_id,route_id,consumer_id,method,path,status,
    latency_kong_ms,latency_upstream_ms,latency_total_ms,toString(client_ip) AS client_ip,toString(request_size) AS request_size,toString(response_size) AS response_size,retention_days,
    ingress_stream_id,ingress_batch_id,ingress_copy_id,toString(ingress_generation) AS ingress_generation,ingress_wire
    FROM requests_v2_copies WHERE id IN {ids:Array(UUID)} LIMIT 10001`,query_params:{ids:[...new Set(input.copies.map(c=>String(c.event.id)))]},format:"JSONEachRow",abort_signal:signal,
    clickhouse_settings:{max_rows_to_read:"5000000",max_bytes_to_read:String(256*1024*1024),read_overflow_mode:"throw",max_result_rows:"10000",max_result_bytes:String(2*1024*1024),result_overflow_mode:"throw",max_memory_usage:String(256*1024*1024),max_execution_time:5,max_threads:2,wait_end_of_query:1,cancel_http_readonly_queries_on_client_close:1,log_queries:0,output_format_json_quote_64bit_integers:1}});
   let body:string;try{body=await result.text();}finally{result.close();}
   if(Buffer.byteLength(body)>2*1024*1024)throw failed();
   const seen=new Set<string>(),observedCopies:ObservedCopyIdentity[]=[];
   const logicalKey=(copy:IngestionCopy)=>JSON.stringify([copy.podUid,copy.requestId,copyStateOf(String(copy.event.id),copy.event).minContent]);
   const witnesses=new Map<string,{values:Set<string>;expires:number;unavailable:boolean}>();
   for(const x of expected.values()){
    const id=String(x.copy.event.id),prior=witnesses.get(id)??{values:new Set<string>(),expires:0,unavailable:false};
    prior.values.add(logicalKey(x.copy));prior.expires=Math.max(prior.expires,Date.parse(x.copy.event.ts as string)+(x.copy.event.retentionDays as number)*86400000);witnesses.set(id,prior);
   }
   for(const line of body.split("\n").filter(Boolean)){
    let requestId:unknown;
    try{
     const value:unknown=JSON.parse(line);if(!value||typeof value!=="object"||Array.isArray(value))throw failed();
     const {ingress_stream_id,ingress_batch_id,ingress_copy_id,ingress_generation,ingress_wire,...encoded}=value as Record<string,unknown>;
     requestId=encoded.id;
     if(typeof ingress_wire!=="string"||typeof ingress_stream_id!=="string"||!uuid.test(ingress_stream_id)||typeof ingress_batch_id!=="string"||!uuid.test(ingress_batch_id)||typeof ingress_copy_id!=="string"||!uuid.test(ingress_copy_id)||typeof ingress_generation!=="string"||!/^[1-9][0-9]{0,18}$/.test(ingress_generation)||BigInt(ingress_generation)>9223372036854775807n)throw failed();
     const parsed:unknown=JSON.parse(ingress_wire);if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw failed();const stored=parsed as Record<string,unknown>;
     if(Object.keys(stored).sort().join(",")!=="copyId,event,podUid,requestId,schemaVersion"||stored.schemaVersion!==1||stored.copyId!==ingress_copy_id||typeof stored.podUid!=="string"||!uuid.test(stored.podUid)||typeof stored.requestId!=="string"||!/^[0-9a-f]{32}$/.test(stored.requestId)||!stored.event||typeof stored.event!=="object"||Array.isArray(stored.event))throw failed();
     const copy:IngestionCopy={schemaVersion:1,copyId:ingress_copy_id,podUid:stored.podUid,requestId:stored.requestId,event:stored.event as Record<string,unknown>};
     const {id,...content}=copy.event;
     if(typeof id!=="string"||id!==encoded.id||wire(copy)!==ingress_wire)throw failed();
     const hex=digest(String(copy.event.clusterId)+"|"+copy.podUid+"|"+copy.requestId).slice(0,32);
     if(id.replaceAll("-","")!==hex)throw failed();
     const original=encodeRawRequestCopy({id,content});
     // Only a self-consistent stored row is a witness of difference. Corruption means missing evidence.
     if(copyStateOf(id,{...encoded,client_ip:canonicalIp(encoded.client_ip)}).minContent!==copyStateOf(id,{...original,client_ip:canonicalIp(original.client_ip)}).minContent)throw failed();
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
   return {storedCopies:live.length,expiredCopies:expected.size-live.length,observedCopies};
  }catch(error){if(error instanceof CopyEvidenceError)throw error;throw failed();}
 }
}
