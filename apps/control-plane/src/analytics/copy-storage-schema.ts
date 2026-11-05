import { BoundedCopyQueries,copyReadNotReady } from "./bounded-copy-queries.js";

// Compare every logical column, including ingress identity; an unknown column must not be silently omitted.
const columns:readonly (readonly [string,string])[]=[
 ["id","UUID"],["ts","DateTime64(3, 'UTC')"],["environment_id","UUID"],["cluster_id","UUID"],
 ["service_id","Nullable(UUID)"],["route_id","Nullable(UUID)"],["consumer_id","Nullable(UUID)"],
 ["method","LowCardinality(String)"],["path","String"],["status","UInt16"],
 ["latency_kong_ms","Float64"],["latency_upstream_ms","Nullable(Float64)"],["latency_total_ms","Float64"],
 ["client_ip","IPv6"],["request_size","UInt64"],["response_size","UInt64"],["retention_days","UInt8"],
 ["ingress_stream_id","Nullable(UUID)"],["ingress_batch_id","Nullable(UUID)"],["ingress_copy_id","Nullable(UUID)"],
 ["ingress_generation","Nullable(UInt64)"],["ingress_wire","Nullable(String)"],
];

/** Internal, bounded catalog read in the same authenticated resource/session/budget as the copy observation. */
export async function assertCopyStorageSchema(queries:BoundedCopyQueries){
 // DESCRIBE includes per-column TTL, which system.columns does not expose on the supported server version.
 const rows=await queries.query("DESCRIBE TABLE requests_v2_copies",{},columns.length+1,true);
 if(rows.length!==columns.length)throw copyReadNotReady();
 for(let index=0;index<columns.length;index++){
  const row=rows[index]!,[name,type]=columns[index]!;
  if(row.name!==name||row.type!==type||row.default_type!==""||row.default_expression!==""||row.ttl_expression!==""||row.codec_expression!=="")throw copyReadNotReady();
 }
}
