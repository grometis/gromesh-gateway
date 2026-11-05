import type pg from "pg";
import { BoundedCopyReader, type CopyReadWindow, type CopyReadBudget } from "./bounded-copy-reader.js";
import { withIngestionReadSnapshot,readAdmissionPrefix } from "./ingestion-read-snapshot.js";
import { readCopyEvidenceSnapshot } from "./copy-evidence.js";
import { routeHistoryEvidenceSnapshot } from "./route-history-evidence.js";
import { evaluateStorageEvidence,foldStorageCopies } from "./storage-consistency.js";
import { attributeRouteHistoryV2 } from "./route-history-v2.js";
/** Internal diagnostics, never an operational serving API or alternative attribution policy. */
export class HistoricalCopyReader{
 constructor(private readonly pool:pg.Pool,private readonly reader:BoundedCopyReader){}
 async read(window:CopyReadWindow,budget:CopyReadBudget={},signal?:AbortSignal){
  return withIngestionReadSnapshot(this.pool,async(db,deadline)=>{
   const abort=AbortSignal.any([deadline,...(signal?[signal]:[])]);
   const prefix=await readAdmissionPrefix(db);
   const raw=await this.reader.read(window,budget,abort);
   const negatives=await readCopyEvidenceSnapshot(db,raw.items.map(i=>i.id));
   const contents=raw.items.flatMap(i=>i.evidence?.kind==="identical"?[i.evidence.content]:[]);
   const strings=(key:string)=>[...new Set(contents.flatMap(c=>typeof c[key]==="string"?[c[key] as string]:[]))];
   const history=await routeHistoryEvidenceSnapshot(db,window.instanceId,{from:window.from,to:window.to,routeIds:strings("routeId"),clusterIds:strings("clusterId")});
   const items=raw.items.map(item=>{
    const negative=negatives.items.find(n=>n.id===item.id);
    const evidence=negative?.kind==="conflicting-copies"?foldStorageCopies({id:item.id,previous:{id:item.id,kind:"conflicting-copies",expiresAt:negative.expiresAt,provenanceComplete:false},
     copies:item.evidence?.kind==="identical"?[{id:item.id,content:item.evidence.content,provenance:"unknown"}]:[],budget:{maxRows:10000,maxDecodedBytes:2*1024*1024}}).evidence:negative?null:item.evidence;
    const storage=evaluateStorageEvidence(evidence,{asOf:history.asOf,...raw.proof});
    const content=evidence?.kind==="identical"?evidence.content:null;
    const attribution=attributeRouteHistoryV2(history,{copiesComplete:false,copies:content&&typeof content.environmentId==="string"&&typeof content.clusterId==="string"&&typeof content.ts==="string"&&(content.routeId===null||typeof content.routeId==="string")?
     [{id:item.id,provenance:"unknown",content:{...content,environmentId:content.environmentId,clusterId:content.clusterId,routeId:content.routeId,ts:content.ts}}]:[],retainedCopyState:null});
    return {id:item.id,ts:item.ts,evidenceKind:evidence?.kind??"comparison-unavailable",storage,attribution};
   });
   if(abort.aborted)throw Error("Historical copy read cancelled");
   return {items,next:raw.next,usage:raw.usage,prefix,historyPruned:negatives.historyPruned,proof:raw.proof};
  });
 }
}
