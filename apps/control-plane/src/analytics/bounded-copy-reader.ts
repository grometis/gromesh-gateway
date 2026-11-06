import type { ClickHouseClient } from "@clickhouse/client";
import { BoundedCopyQueries,type CopyReadBudget } from "./bounded-copy-queries.js";
export type { CopyReadBudget } from "./bounded-copy-queries.js";
import { foldStorageCopies, StorageConsistencyError, type StorageCopyEvidence } from "./storage-consistency.js";
import { encodeRawRequestCopy } from "./request-copy-store.js";

export interface CopyReadWindow {
  readonly instanceId:string; readonly from:string; readonly to:string; readonly pageSize:number;
  /** Internal keyset only. This is not the planned authenticated public cursor. */
  readonly after?:{readonly id:string;readonly ts:string};
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const notReady=()=>new StorageConsistencyError("analytics-not-ready","Copy storage evidence is not ready");
const exceeded=()=>new StorageConsistencyError("analytics-budget-exceeded","Copy read budget exceeded");
function time(value:string):number {
 const ms=Date.parse(value);if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)||!Number.isFinite(ms)||new Date(ms).toISOString()!==value)throw new Error("Invalid copy read");return ms;
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
  if(this.busy)throw notReady();this.busy=true;
  let queries:BoundedCopyQueries;
  try{queries=new BoundedCopyQueries(this.client,budget,signal);}catch(error){this.busy=false;throw error;}
  const usage=queries.usage,abort=queries.signal;
  const query=queries.query.bind(queries);
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
    const folded=foldStorageCopies({id:c.id as string,previous:null,copies:copies.filter(r=>r.id===c.id),budget:{maxRows:10000,maxDecodedBytes:queries.maxDecodedBytes}});
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
