import type { ClickHouseClient } from "@clickhouse/client";
import { foldStorageCopies, StorageConsistencyError, type StorageCopyEvidence } from "./storage-consistency.js";
import { encodeRawRequestCopy } from "./request-copy-store.js";

export interface CopyReadWindow {
  readonly instanceId:string; readonly from:string; readonly to:string; readonly pageSize:number;
  /** Internal keyset only. This is not the planned authenticated public cursor. */
  readonly after?:{readonly id:string;readonly ts:string};
}
export interface CopyReadBudget { readonly maxReadRows?:number;readonly maxReadBytes?:number;readonly maxDecodedBytes?:number }
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const notReady=()=>new StorageConsistencyError("analytics-not-ready","Copy storage evidence is not ready");
const exceeded=()=>new StorageConsistencyError("analytics-budget-exceeded","Copy read budget exceeded");
function time(value:string):number {
 const ms=Date.parse(value);if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)||!Number.isFinite(ms)||new Date(ms).toISOString()!==value)throw new Error("Invalid copy read");return ms;
}
function bounded(value:number|undefined,max:number):number {const n=value??max;if(!Number.isSafeInteger(n)||n<1||n>max)throw new Error("Invalid copy read");return n;}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value))throw notReady();return value as Record<string,unknown>;}
function natural(value:unknown):number {
 if(typeof value!=="string"||!/^(?:0|[1-9][0-9]*)$/.test(value)||value.length>16||BigInt(value)>BigInt(Number.MAX_SAFE_INTEGER))throw notReady();return Number(value);
}
const columns=`id, toString(toUnixTimestamp64Milli(ts)) AS tsMs, environment_id AS environmentId, cluster_id AS clusterId,
 service_id AS serviceId, route_id AS routeId, consumer_id AS consumerId, method, path, status,
 latency_kong_ms AS latencyKongMs, latency_upstream_ms AS latencyUpstreamMs, latency_total_ms AS latencyTotalMs,
 toString(client_ip) AS clientIp, toString(request_size) AS requestSize, toString(response_size) AS responseSize, retention_days AS retentionDays`;
function decoded(row:Record<string,unknown>) {
 const {id,tsMs,...rest}=row;if(typeof id!=="string"||typeof tsMs!=="string"||!/^[-]?[0-9]{1,16}$/.test(tsMs))throw notReady();
 const ms=Number(tsMs);if(!Number.isSafeInteger(ms)||!Number.isFinite(new Date(ms).getTime()))throw notReady();
 const content={...rest,ts:new Date(ms).toISOString()};try{encodeRawRequestCopy({id,content});}catch{throw notReady();}
 return {id,content,provenance:"unknown" as const};
}

/** Mechanical bounded raw reader. No receipt/cluster proof can be supplied as a caller boolean. */
export class BoundedCopyReader {
 private busy=false;
 constructor(private readonly client:ClickHouseClient) {}
 async read(window:CopyReadWindow,budget:CopyReadBudget={},signal?:AbortSignal) {
  const from=time(window.from),to=time(window.to);
  if(!uuid.test(window.instanceId)||from>=to||to-from>7*86400000||!Number.isSafeInteger(window.pageSize)||window.pageSize<1||window.pageSize>200)throw new Error("Invalid copy read");
  if(window.after&&(!uuid.test(window.after.id)||time(window.after.ts)<from||time(window.after.ts)>=to))throw new Error("Invalid copy read");
  const limits={rows:bounded(budget.maxReadRows,5_000_000),bytes:bounded(budget.maxReadBytes,256*1024*1024),decoded:bounded(budget.maxDecodedBytes,2*1024*1024)};
  if(this.busy)throw notReady();this.busy=true;
  const usage={readRows:0,readBytes:0,decodedBytes:0,dbElapsedNs:0};
  const abort=AbortSignal.any([AbortSignal.timeout(8000),...(signal?[signal]:[])]);
  const started=performance.now();
  const query=async(text:string,params:Record<string,unknown>,maxRows:number)=>{
   if(abort.aborted)throw notReady();
   if(usage.readRows>=limits.rows||usage.readBytes>=limits.bytes||usage.decodedBytes>=limits.decoded)throw exceeded();
   if(usage.dbElapsedNs>=5_000_000_000)throw exceeded();
   const seconds=Math.min((5_000_000_000-usage.dbElapsedNs)/1_000_000_000,(8000-(performance.now()-started))/1000);if(seconds<=0)throw notReady();
   const result=await this.client.query({query:text,query_params:params,format:"JSONEachRowWithProgress",abort_signal:abort,
    clickhouse_settings:{max_threads:2,max_block_size:"100",max_execution_time:seconds,timeout_overflow_mode:"throw",max_memory_usage:String(256*1024*1024),
     max_rows_to_read:String(limits.rows-usage.readRows),max_bytes_to_read:String(limits.bytes-usage.readBytes),read_overflow_mode:"throw",
     max_result_rows:String(maxRows),max_result_bytes:String(limits.decoded-usage.decodedBytes),result_overflow_mode:"throw",max_rows_to_group_by:"10000",group_by_overflow_mode:"throw",
     wait_end_of_query:1,http_response_buffer_size:String(2*1024*1024),output_format_json_quote_64bit_integers:1,cancel_http_readonly_queries_on_client_close:1,log_queries:0}});
   const rows:Record<string,unknown>[]=[];let progressRows=0,progressBytes=0;
   try{for await(const chunk of result.stream<unknown>())for(const line of chunk){
     usage.decodedBytes+=Buffer.byteLength(line.text,"utf8");if(usage.decodedBytes>limits.decoded)throw exceeded();
     const item=object(line.json());
     if(Object.hasOwn(item,"progress")){
      const p=object(item.progress);
      // Progress is a lower bound only; final wait_end_of_query summary accounts actual engine reads.
      progressRows=Math.max(progressRows,natural(p.read_rows));progressBytes=Math.max(progressBytes,natural(p.read_bytes));
      if(usage.readRows+progressRows>limits.rows||usage.readBytes+progressBytes>limits.bytes)throw exceeded();
     }else if(Object.hasOwn(item,"row")){rows.push(object(item.row));if(rows.length>maxRows)throw exceeded();}
     else if(Object.hasOwn(item,"meta")){
      if(Object.keys(item).length!==1||!Array.isArray(item.meta)||item.meta.length>20||!item.meta.every(m=>m&&typeof m==="object"&&typeof m.name==="string"&&typeof m.type==="string"))throw notReady();
     }else if(Object.hasOwn(item,"rows_before_limit_at_least")||Object.hasOwn(item,"rows_before_aggregation")){
      if(Object.keys(item).length!==1)throw notReady();const n=Object.values(item)[0];if(typeof n!=="number"&&typeof n!=="string")throw notReady();natural(String(n));
     }else throw notReady();
   }}finally{result.close();}
   const summary=result.response_headers["x-clickhouse-summary"];
   if(typeof summary!=="string")throw notReady();const total=object(JSON.parse(summary));
   const readRows=natural(total.read_rows),readBytes=natural(total.read_bytes);
   if(readRows<progressRows||readBytes<progressBytes)throw notReady();
   usage.readRows+=readRows;usage.readBytes+=readBytes;usage.dbElapsedNs+=natural(total.elapsed_ns);
   if(usage.readRows>limits.rows||usage.readBytes>limits.bytes||usage.dbElapsedNs>5_000_000_000)throw exceeded();
   return rows;
  };
  try{
   const cursor=window.after?" HAVING (max(ts), toString(id))<(fromUnixTimestamp64Milli({cursorMs:Int64}),{cursorId:String})":"";
   const candidates=await query(`SELECT id,toString(toUnixTimestamp64Milli(max(ts))) AS tsMs FROM requests_v2_copies
    WHERE environment_id={instanceId:UUID} AND ts>=fromUnixTimestamp64Milli({fromMs:Int64}) AND ts<fromUnixTimestamp64Milli({toMs:Int64})
    GROUP BY id${cursor} ORDER BY max(ts) DESC,toString(id) DESC LIMIT {limit:UInt32}`,
    {instanceId:window.instanceId,fromMs:from,toMs:to,limit:window.pageSize+1,...(window.after?{cursorMs:time(window.after.ts),cursorId:window.after.id}:{})},window.pageSize+1);
   const page=candidates.slice(0,window.pageSize);
   const ids=page.map(c=>{if(typeof c.id!=="string"||!uuid.test(c.id))throw notReady();return c.id;});
   // Global lookup deliberately has no instance, time, status, route or Workspace predicate.
   const copies=ids.length?(await query(`SELECT ${columns} FROM requests_v2_copies WHERE id IN {ids:Array(UUID)}`,{ids},10000)).map(decoded):[];
   const items=page.map(c=>{
    if(abort.aborted)throw notReady();
    if(typeof c.tsMs!=="string"||!/^[-]?[0-9]{1,16}$/.test(c.tsMs))throw notReady();
    const folded=foldStorageCopies({id:c.id as string,previous:null,copies:copies.filter(r=>r.id===c.id),budget:{maxRows:10000,maxDecodedBytes:limits.decoded}});
    return {id:c.id as string,ts:new Date(Number(c.tsMs)).toISOString(),evidence:folded.evidence as StorageCopyEvidence|null};
   });
   if(abort.aborted)throw notReady();
   return {items,next:candidates.length>window.pageSize?{id:items.at(-1)!.id,ts:items.at(-1)!.ts}:null,usage,
    // Neither SELECT success nor matching raw copies proves admissions, conflict retention, or a cross-store snapshot.
    proof:{copiesComplete:false as const,conflictHistoryComplete:false as const,coherentSnapshot:false as const}};
  }catch(error){
   if(error instanceof StorageConsistencyError)throw error;
   const code=error&&typeof error==="object"&&"code" in error?String(error.code):"";
   if(["158","159","241","307","396"].includes(code))throw exceeded();
   throw notReady();
  }finally{this.busy=false;}
 }
}
