import type { ClickHouseClient } from "@clickhouse/client";
import { StorageConsistencyError } from "./storage-consistency.js";
export interface CopyReadBudget { readonly maxReadRows?:number;readonly maxReadBytes?:number;readonly maxDecodedBytes?:number }
export const copyReadNotReady=()=>new StorageConsistencyError("analytics-not-ready","Copy storage evidence is not ready");
const exceeded=()=>new StorageConsistencyError("analytics-budget-exceeded","Copy read budget exceeded");
type Settings=NonNullable<Parameters<ClickHouseClient['query']>[0]['clickhouse_settings']>;
function bounded(value:number|undefined,max:number):number {const n=value??max;if(!Number.isSafeInteger(n)||n<1||n>max)throw new Error("Invalid copy read");return n;}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value))throw copyReadNotReady();return value as Record<string,unknown>;}
function natural(value:unknown):number {
 if(typeof value!=="string"||!/^(?:0|[1-9][0-9]*)$/.test(value)||value.length>16||BigInt(value)>BigInt(Number.MAX_SAFE_INTEGER))throw copyReadNotReady();return Number(value);
}
function failure(error:unknown):Error{
 if(error instanceof StorageConsistencyError)return error;const code=error&&typeof error==="object"&&"code" in error?String(error.code):"";
 return ["158","159","241","307","396"].includes(code)?exceeded():copyReadNotReady();
}
type CopyQueryStage='limits'|'insert-request'|'insert-accounting'|'select-request'|'select-stream'|'select-accounting';
/** Safe stage only: never retain the server response, payload, URL, credentials or original cause. */
export class CopyQueryFailure extends StorageConsistencyError {
 constructor(readonly stage:CopyQueryStage,error:unknown){const safe=failure(error),code=safe instanceof StorageConsistencyError?safe.code:'analytics-not-ready';super(code,code==='analytics-budget-exceeded'?'Copy read budget exceeded':'Copy storage evidence is not ready');this.name='CopyQueryFailure';}
}
/** One aggregate budget across metadata, INSERT, candidate, copy and final-fence queries. */
export class BoundedCopyQueries {
 readonly usage={readRows:0,readBytes:0,decodedBytes:0,dbElapsedNs:0};
 private readonly limits:{rows:number;bytes:number;decoded:number};private readonly started=performance.now();
 readonly signal:AbortSignal;
 constructor(private readonly client:ClickHouseClient,budget:CopyReadBudget={},signal?:AbortSignal,private readonly sessionId?:string,parent?:BoundedCopyQueries){
  if(parent){this.limits=parent.limits;this.usage=parent.usage;this.started=parent.started;this.signal=parent.signal;return;}
  this.limits={rows:bounded(budget.maxReadRows,5_000_000),bytes:bounded(budget.maxReadBytes,256*1024*1024),decoded:bounded(budget.maxDecodedBytes,2*1024*1024)};
  this.signal=AbortSignal.any([AbortSignal.timeout(8000),...(signal?[signal]:[])]);
 }
 /** Two authenticated HTTP identities share a budget without pretending they share a server session. */
 withSession(client:ClickHouseClient,sessionId?:string){return new BoundedCopyQueries(client,{},undefined,sessionId,this);}
 get maxDecodedBytes(){return this.limits.decoded;}
 private settings(maxRows:number,sessionExists:boolean):Settings{
  const {usage,limits,signal}=this;if(signal.aborted)throw copyReadNotReady();
  if(usage.readRows>=limits.rows||usage.readBytes>=limits.bytes||usage.decodedBytes>=limits.decoded||usage.dbElapsedNs>=5_000_000_000)throw exceeded();
  const seconds=Math.min((5_000_000_000-usage.dbElapsedNs)/1e9,(8000-(performance.now()-this.started))/1000);if(seconds<=0)throw copyReadNotReady();
  return {...(this.sessionId?{session_timeout:"10",session_check:sessionExists?1:0}:{}),max_threads:2,max_block_size:"100",max_execution_time:seconds,timeout_overflow_mode:"throw",max_memory_usage:String(256*1024*1024),
   max_rows_to_read:String(limits.rows-usage.readRows),max_bytes_to_read:String(limits.bytes-usage.readBytes),read_overflow_mode:"throw",
   max_result_rows:String(maxRows),max_result_bytes:String(limits.decoded-usage.decodedBytes),result_overflow_mode:"throw",max_rows_to_group_by:"10000",group_by_overflow_mode:"throw",
   wait_end_of_query:1,http_response_buffer_size:String(2*1024*1024),output_format_json_quote_64bit_integers:1,cancel_http_readonly_queries_on_client_close:1,log_queries:0};
 }
 private account(headers:Readonly<Record<string,unknown>>,progressRows=0,progressBytes=0){
  const summary=headers['x-clickhouse-summary'];if(typeof summary!=="string"||Buffer.byteLength(summary)>16384)throw copyReadNotReady();
  this.usage.decodedBytes+=Buffer.byteLength(summary);const total=object(JSON.parse(summary));
  const readRows=natural(total.read_rows),readBytes=natural(total.read_bytes);if(readRows<progressRows||readBytes<progressBytes)throw copyReadNotReady();
  this.usage.readRows+=readRows;this.usage.readBytes+=readBytes;this.usage.dbElapsedNs+=natural(total.elapsed_ns);
  if(this.usage.readRows>this.limits.rows||this.usage.readBytes>this.limits.bytes||this.usage.decodedBytes>this.limits.decoded||this.usage.dbElapsedNs>5e9)throw exceeded();
  if(this.signal.aborted)throw copyReadNotReady();
 }
 async insert(params:Parameters<ClickHouseClient['insert']>[0]){
  let stage:CopyQueryStage='limits';
  try{
   const settings=this.settings(1,true);
   stage="insert-request";const result=await this.client.insert({...params,abort_signal:this.signal,...(this.sessionId?{session_id:this.sessionId}:{}),
    clickhouse_settings:{...params.clickhouse_settings,...settings,async_insert:0,insert_deduplicate:0}});
   stage="insert-accounting";if(result.executed)this.account(result.response_headers);return result;
  }catch(error){throw new CopyQueryFailure(stage,error);}
 }
 async query(text:string,params:Record<string,unknown>,maxRows:number,sessionExists=false){
  const {usage,limits,signal}=this;let stage:CopyQueryStage="limits";
  try{
   const settings=this.settings(maxRows,sessionExists);stage="select-request";const result=await this.client.query({query:text,query_params:params,format:"JSONEachRowWithProgress",abort_signal:signal,...(this.sessionId?{session_id:this.sessionId}:{}),clickhouse_settings:settings});
   const rows:Record<string,unknown>[]=[];let progressRows=0,progressBytes=0;
   stage="select-stream";try{for await(const chunk of result.stream<unknown>())for(const line of chunk){
    usage.decodedBytes+=Buffer.byteLength(line.text,"utf8");if(usage.decodedBytes>limits.decoded)throw exceeded();const item=object(line.json());
    if(Object.hasOwn(item,"progress")){const p=object(item.progress);progressRows=Math.max(progressRows,natural(p.read_rows));progressBytes=Math.max(progressBytes,natural(p.read_bytes));if(usage.readRows+progressRows>limits.rows||usage.readBytes+progressBytes>limits.bytes)throw exceeded();}
    else if(Object.hasOwn(item,"row")){rows.push(object(item.row));if(rows.length>maxRows)throw exceeded();}
    else if(Object.hasOwn(item,"meta")){if(Object.keys(item).length!==1||!Array.isArray(item.meta)||item.meta.length>64||!item.meta.every(m=>m&&typeof m==="object"&&typeof m.name==="string"&&typeof m.type==="string"))throw copyReadNotReady();}
    else if(Object.hasOwn(item,"rows_before_limit_at_least")||Object.hasOwn(item,"rows_before_aggregation")){if(Object.keys(item).length!==1)throw copyReadNotReady();const n=Object.values(item)[0];if(typeof n!=="number"&&typeof n!=="string")throw copyReadNotReady();natural(String(n));}
    else throw copyReadNotReady();
   }}finally{result.close();}
   stage="select-accounting";this.account(result.response_headers,progressRows,progressBytes);return rows;
  }catch(error){throw new CopyQueryFailure(stage,error);}
 }
}
