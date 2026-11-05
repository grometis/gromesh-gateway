import type { ClickHouseClient } from "@clickhouse/client";
import type { IngestionCopy } from "./ingestion-admissions.js";
import { encodeRawRequestCopy } from "./request-copy-store.js";
import { copyStateOf } from "./copy-state.js";
const failed=()=>new Error("Ingestion persistence is not confirmed");
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
    FROM requests_v2_copies WHERE ingress_batch_id={batch:UUID} LIMIT 10001`,query_params:{batch:input.batchId},format:"JSONEachRow",abort_signal:signal,
    clickhouse_settings:{max_rows_to_read:"10000",max_bytes_to_read:String(2*1024*1024),read_overflow_mode:"throw",max_result_rows:"10000",max_result_bytes:String(2*1024*1024),result_overflow_mode:"throw",max_memory_usage:String(256*1024*1024),max_execution_time:5,max_threads:2,wait_end_of_query:1,cancel_http_readonly_queries_on_client_close:1,log_queries:0,output_format_json_quote_64bit_integers:1}});
   let body:string;try{body=await result.text();}finally{result.close();}
   if(Buffer.byteLength(body)>2*1024*1024)throw failed();
   const seen=new Set<string>();
   for(const line of body.split("\n").filter(Boolean)){
    const value:unknown=JSON.parse(line);if(!value||typeof value!=="object"||Array.isArray(value))throw failed();
    const {ingress_stream_id,ingress_batch_id,ingress_copy_id,ingress_generation,ingress_wire,...encoded}=value as Record<string,unknown>;
    if(typeof ingress_copy_id!=="string")throw failed();const x=expected.get(ingress_copy_id);
    if(!x||ingress_stream_id!==input.streamId||ingress_batch_id!==input.batchId||ingress_generation!==input.generation||ingress_wire!==x.wire||copyStateOf(String(x.copy.event.id),encoded).minContent!==copyStateOf(String(x.copy.event.id),x.encoded).minContent)throw failed();
    seen.add(ingress_copy_id);
   }
   if(live.some(x=>!seen.has(x.copy.copyId)))throw failed();
   const logical=new Map<string,string>();
   for(const x of expected.values()){
    const id=String(x.copy.event.id),canonical=JSON.stringify([x.copy.podUid,x.copy.requestId,copyStateOf(id,x.copy.event).minContent]);
    if(logical.has(id)&&logical.get(id)!==canonical)throw failed();logical.set(id,canonical);
   }
   if(signal.aborted)throw failed();
   return {storedCopies:live.length,expiredCopies:expected.size-live.length};
  }catch{throw failed();}
 }
}
