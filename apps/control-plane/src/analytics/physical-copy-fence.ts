import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import { BoundedCopyQueries,copyReadNotReady,type CopyReadBudget } from "./bounded-copy-queries.js";
import { assertCopyStorageSchema } from "./copy-storage-schema.js";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const metadata=`SELECT toString(t.uuid) AS tableId,t.engine,t.create_table_query AS definition,
 (SELECT arraySort(groupArray(tuple(name,toString(uuid),toString(rows),toString(bytes_on_disk),toString(data_version)))) FROM system.parts WHERE database=currentDatabase() AND table='requests_v2_copies' AND active) AS parts
 FROM system.tables t WHERE t.database=currentDatabase() AND t.name='requests_v2_copies'`;
function decodeMetadata(rows:Record<string,unknown>[]){
 const row=rows[0];if(rows.length!==1||!row||typeof row.tableId!=="string"||!uuid.test(row.tableId)||row.tableId==="00000000-0000-0000-0000-000000000000"||row.engine!=="MergeTree"||typeof row.definition!=="string"||!Array.isArray(row.parts)||row.parts.length>1000)throw copyReadNotReady();
 const parts=row.parts as unknown[];
 if(!parts.every(p=>Array.isArray(p)&&p.length===5&&p.every(v=>typeof v==="string")&&/^[a-zA-Z0-9_-]+$/.test(p[0] as string)))throw copyReadNotReady();
 return {tableId:row.tableId,definition:row.definition,parts:parts as string[][]};
}
export async function observePhysicalCopyCut(queries:BoundedCopyQueries,sessionExists=false){
 return decodeMetadata(await queries.query(metadata,{},1,sessionExists));
}
/** An observation of one immutable-part cut, NOT proof of admitted-prefix or source completeness. */
export class PhysicalCopyFence {
 private busy=false;
 constructor(private readonly client:ClickHouseClient){}
 async observe(ids:readonly string[],budget:CopyReadBudget={},signal?:AbortSignal,context?:BoundedCopyQueries,sessionExists=false){
  if(ids.length>10000||ids.some(id=>!uuid.test(id)))throw Error("Invalid physical copy read");
  if(this.busy)throw copyReadNotReady();this.busy=true;
  try{
   const queries=context??new BoundedCopyQueries(this.client,budget,signal,`gromesh-copy-fence-${randomUUID()}`);
   const before=await observePhysicalCopyCut(queries,sessionExists);
   await assertCopyStorageSchema(queries);
   // A new part cannot silently enter the read cut, even if a later merge or TTL removes it.
   const rows=ids.length?await queries.query(`SELECT id,toString(ts) AS ts,environment_id,cluster_id,service_id,route_id,consumer_id,method,path,status,
    latency_kong_ms,latency_upstream_ms,latency_total_ms,toString(client_ip) AS client_ip,toString(request_size) AS request_size,toString(response_size) AS response_size,retention_days,
    ingress_stream_id,ingress_batch_id,ingress_copy_id,toString(ingress_generation) AS ingress_generation,ingress_wire
    FROM requests_v2_copies WHERE id IN {ids:Array(UUID)} AND _part IN {parts:Array(String)} LIMIT 10001`,{ids:[...new Set(ids)],parts:before.parts.map(p=>p[0]!)},10000,true):[];
   const after=await observePhysicalCopyCut(queries,true);
   await assertCopyStorageSchema(queries);
   // Exact tuples and schema, not a digest or only max(block_number). Any change refuses this observation.
   if(JSON.stringify(before)!==JSON.stringify(after))throw copyReadNotReady();
   return {rows,tableId:before.tableId,parts:before.parts,usage:queries.usage,
    proof:{copiesComplete:false as const,conflictHistoryComplete:false as const,coherentSnapshot:false as const,deliveryFromKongComplete:false as const}};
  }finally{this.busy=false;}
 }
}
