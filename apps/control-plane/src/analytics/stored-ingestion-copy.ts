import { createHash } from "node:crypto";
import type { IngestionCopy } from "./ingestion-admissions.js";
import { encodeRawRequestCopy } from "./request-copy-store.js";
import { copyStateOf } from "./copy-state.js";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const failed=()=>Error("Ingestion persistence is not confirmed");
const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
const canonicalIp=(value:unknown)=>{if(typeof value!=="string")throw failed();return new URL(`http://[${value}]/`).hostname;};
export const ingestionWire=(copy:IngestionCopy)=>JSON.stringify({schemaVersion:copy.schemaVersion,copyId:copy.copyId,podUid:copy.podUid,requestId:copy.requestId,event:Object.fromEntries(Object.keys(copy.event).sort().map(k=>[k,copy.event[k]]))});
export const ingestionLogicalContent=(copy:IngestionCopy)=>JSON.stringify([copy.podUid,copy.requestId,copyStateOf(String(copy.event.id),copy.event).minContent]);
/** Transport metadata is validated against the typed stored content; this alone does not authenticate its author. */
export function decodeStoredIngestionCopy(value:Record<string,unknown>){
 const {ingress_stream_id,ingress_batch_id,ingress_copy_id,ingress_generation,ingress_wire,...encoded}=value;
 if(typeof ingress_wire!=="string"||typeof ingress_stream_id!=="string"||!uuid.test(ingress_stream_id)||typeof ingress_batch_id!=="string"||!uuid.test(ingress_batch_id)||typeof ingress_copy_id!=="string"||!uuid.test(ingress_copy_id)||typeof ingress_generation!=="string"||!/^[1-9][0-9]{0,18}$/.test(ingress_generation)||BigInt(ingress_generation)>9223372036854775807n)throw failed();
 const parsed:unknown=JSON.parse(ingress_wire);if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw failed();const stored=parsed as Record<string,unknown>;
 if(Object.keys(stored).sort().join(",")!=="copyId,event,podUid,requestId,schemaVersion"||stored.schemaVersion!==1||stored.copyId!==ingress_copy_id||typeof stored.podUid!=="string"||!uuid.test(stored.podUid)||typeof stored.requestId!=="string"||!/^[0-9a-f]{32}$/.test(stored.requestId)||!stored.event||typeof stored.event!=="object"||Array.isArray(stored.event))throw failed();
 const copy:IngestionCopy={schemaVersion:1,copyId:ingress_copy_id,podUid:stored.podUid,requestId:stored.requestId,event:stored.event as Record<string,unknown>};
 const {id,...content}=copy.event;if(typeof id!=="string"||id!==encoded.id||ingestionWire(copy)!==ingress_wire)throw failed();
 const hex=digest(String(copy.event.clusterId)+"|"+copy.podUid+"|"+copy.requestId).slice(0,32);if(id.replaceAll("-","")!==hex)throw failed();
 const original=encodeRawRequestCopy({id,content});
 if(copyStateOf(id,{...encoded,client_ip:canonicalIp(encoded.client_ip)}).minContent!==copyStateOf(id,{...original,client_ip:canonicalIp(original.client_ip)}).minContent)throw failed();
 return {copy,streamId:ingress_stream_id,batchId:ingress_batch_id,generation:ingress_generation,wire:ingress_wire,
  commitment:digest(copyStateOf(id,copy.event).minContent),expiresAt:new Date(Date.parse(copy.event.ts as string)+(copy.event.retentionDays as number)*86400000).toISOString()};
}
