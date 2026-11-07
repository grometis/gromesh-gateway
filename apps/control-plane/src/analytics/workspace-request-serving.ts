import {AnalyticsRequestBudget,type AnalyticsBudgetProfile} from "./analytics-request-budget.js";
import { terminateIngestionBackend } from "./ingestion-cancellation.js";
import { createHash, randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import type pg from "pg";
import type { Role } from "../auth/auth.js";
import { maskClientIp } from "./analytics.js";
import { openVerifiedHistoricalReader } from "./verified-historical-reader.js";
import type { TrustedCopyStorageSettings } from "./trusted-copy-storage.js";
import type { WorkspaceRequestQuery } from "./workspace-request-query.js";
import { StorageConsistencyError } from "./storage-consistency.js";

export const WORKSPACE_REQUEST_SERVING = Symbol("WORKSPACE_REQUEST_SERVING");
export interface VerifiedWorkspaceRequestInput {
  instanceId: string; workspaceId: string; principalId: string; role: Role; query: WorkspaceRequestQuery;
  after?: { ts: string; id: string }; issueCursor: (last: { ts: string; id: string }) => string; signal: AbortSignal; budget?:AnalyticsRequestBudget;
}
export interface WorkspaceRequestServing { readonly budgetProfile?:AnalyticsBudgetProfile;query(input: VerifiedWorkspaceRequestInput): Promise<unknown> }
const unavailable = () => new StorageConsistencyError("analytics-not-ready", "Workspace request evidence is incomplete");
const budget = () => new StorageConsistencyError("analytics-budget-exceeded", "Workspace request budget exceeded");
const busy = () => new HttpException({ type: "about:blank", title: "Too Many Requests", status: 429, detail: "Analytics admission exhausted" },429);
const key = (parts: readonly string[]) => BigInt.asIntN(64, BigInt("0x"+createHash("sha256").update(JSON.stringify(["analytics-v2-query-slot",...parts])).digest("hex").slice(0,16))).toString();

/** Session locks coordinate all replicas without holding a transaction during remote storage work. */
export async function withWorkspaceQuerySlots<T>(pool: pg.Pool, input: VerifiedWorkspaceRequestInput, run: (signal:AbortSignal) => Promise<T>): Promise<T> {
  const queue = AbortSignal.any([input.signal, AbortSignal.timeout(1000)]);
  if(queue.aborted)throw busy();
  const client = await new Promise<pg.PoolClient>((resolve,reject) => {
    const aborted = () => reject(busy()); queue.addEventListener("abort",aborted,{once:true});
    void pool.connect().then(client => { queue.removeEventListener("abort",aborted); if(queue.aborted){client.release();reject(busy());}else resolve(client); },error => { queue.removeEventListener("abort",aborted);reject(error); });
  });
  let restore:(()=>void)|undefined;
  const locks: string[] = []; let destroy = false, released = false, admitted = false, previousName="",pid=0;
  const name=`gromesh-analytics-query:${randomUUID()}`;let cancelling:Promise<boolean>|undefined;
  const leaseLost=new AbortController(),signal=AbortSignal.any([input.signal,leaseLost.signal,AbortSignal.timeout(4500)]);
  const lost=()=>{destroy=true;leaseLost.abort();};
  const ended=()=>{lost();client.removeListener("error",lost);};
  client.on("error",lost);client.once("end",ended);
  const abort = () => { if(!released){released=true;client.release(true);cancelling=terminateIngestionBackend(pool,pid,name);} };
  queue.addEventListener("abort",abort,{once:true});
  try {
    restore=input.budget?.instrument(client);
    const backend=(await client.query<{name:string;pid:number}>("select pg_catalog.current_setting('application_name') name,pg_catalog.pg_backend_pid() pid")).rows[0]!;previousName=backend.name;pid=backend.pid;
    await client.query("select pg_catalog.set_config('application_name',$1,false)",[name]);
    const acquire = async (parts: string[], slots: number) => {
      for(let slot=0;slot<slots;slot++){
        queue.throwIfAborted(); const identity = key([...parts,String(slot)]);
        if((await client.query<{locked:boolean}>("select pg_catalog.pg_try_advisory_lock($1::pg_catalog.int8) locked",[identity])).rows[0]!.locked){locks.push(identity);return;}
      }
      throw busy();
    };
    await acquire(["instance",input.instanceId],8);
    await acquire(["principal-workspace",input.instanceId,input.workspaceId,input.principalId],2);
    queue.throwIfAborted();if(released||destroy)throw busy();
    admitted=true;
    queue.removeEventListener("abort",abort);signal.addEventListener("abort",abort,{once:true});
    if(signal.aborted)abort();signal.throwIfAborted();const result=await run(signal);signal.throwIfAborted();return result;
  } catch(error) {
    if(!admitted&&queue.aborted&&!input.signal.aborted)throw busy();throw error;
  } finally {
    try{
    if(!released){
      try { if(!destroy){for(const identity of locks.reverse())await client.query("select pg_catalog.pg_advisory_unlock($1::pg_catalog.int8)",[identity]);await client.query("select pg_catalog.set_config('application_name',$1,false)",[previousName]);} }
      catch { destroy = true; }
      if(!released){released=true;client.release(destroy);}
    }
    if(cancelling)await cancelling;signal.throwIfAborted();if(destroy)throw unavailable();
    }finally{restore?.();queue.removeEventListener("abort",abort);signal.removeEventListener("abort",abort);if(!destroy&&!signal.aborted){client.removeListener("error",lost);client.removeListener("end",ended);}}
  }
}

/** Inactive prepared composition. The caller owns the pool; only test roots currently install this provider. */
export async function createVerifiedWorkspaceRequests(input: { pool: pg.Pool; settings: Pick<TrustedCopyStorageSettings,"url"|"databaseName"|"reader"|"auditor">;capacity?:number;budgetProfile?:AnalyticsBudgetProfile }) {
  const budgetProfile=input.budgetProfile??'original-physical';
  const capacity = input.capacity ?? 8, settings = structuredClone(input.settings);
  if(!Number.isInteger(capacity)||capacity<1||capacity>8)throw unavailable();
  const readers: { reader: Awaited<ReturnType<typeof openVerifiedHistoricalReader>>;busy:boolean }[] = [];
  let closed = false;
  const close = async () => { closed=true; await Promise.all(readers.map(row=>row.reader.close())); };
  try {
    // Startup resource authentication is not repeated as an unaccounted query inside each request.
    for(let index=0;index<capacity;index++)readers.push({reader:await openVerifiedHistoricalReader({pool:input.pool,settings}),busy:false});
    const query = async (raw: VerifiedWorkspaceRequestInput) => {
      if(!raw.budget||raw.budget.profile!==budgetProfile)throw unavailable();raw.budget.assertServingContract();
      const queryInput = { ...raw, query: structuredClone(raw.query), after: raw.after ? { ...raw.after } : undefined };
      const started = performance.now();
      if(closed)throw unavailable();
      return withWorkspaceQuerySlots(input.pool,queryInput,async signal=>{
        const slot = readers.find(row=>!row.busy);if(!slot)throw busy();slot.busy=true;
        try {
          const q=queryInput.query;
          const page=await slot.reader.read({instanceId:queryInput.instanceId,from:q.from,to:q.to,pageSize:200,...(queryInput.after?{after:queryInput.after}:{})},{operation:queryInput.budget},signal);
          if(page.next||page.items.some(item=>item.storage.kind!=="ready"||item.attribution.workspaceId===null))throw unavailable();
          const selected=page.items.filter(item=>{
            if(item.attribution.workspaceId!==queryInput.workspaceId||item.storage.kind!=="ready")return false;
            const c=item.storage.content;
            return (!q.routeId||c.routeId===q.routeId)&&(!q.serviceId||c.serviceId===q.serviceId)&&(!q.consumerId||c.consumerId===q.consumerId)&&
              (q.status===undefined||c.status===q.status)&&(!q.statusClass||Math.floor(Number(c.status)/100)===Number(q.statusClass[0]));
          });
          const items=selected.slice(0,q.limit).map(item=>{
            if(item.storage.kind!=="ready"||item.attribution.workspaceId===null)throw unavailable();
            const c=item.storage.content;
            if(typeof c.clientIp!=="string")throw unavailable();
            return {id:item.id,ts:item.ts,instanceId:queryInput.instanceId,workspaceId:queryInput.workspaceId,clusterId:c.clusterId,routeId:c.routeId,serviceId:c.serviceId,consumerId:c.consumerId,
              method:c.method,path:c.path,status:c.status,latencyKongMs:c.latencyKongMs,latencyUpstreamMs:c.latencyUpstreamMs,latencyTotalMs:c.latencyTotalMs,
              clientIp:maskClientIp(c.clientIp,queryInput.role),requestSize:c.requestSize,responseSize:c.responseSize,effectiveRevision:null,candidateRevisions:item.candidateRevisions};
          });
          const last=items.at(-1),nextCursor=selected.length>items.length&&last?queryInput.issueCursor({ts:last.ts,id:last.id}):null;
          const result={scope:"workspace",instanceId:queryInput.instanceId,workspaceId:queryInput.workspaceId,from:q.from,to:q.to,generatedAt:page.asOf,attributionVersion:"route-history-v2",retention:"per-route-1-to-7-days",delivery:"best-effort",items,nextCursor};
          if(Buffer.byteLength(JSON.stringify(result))>2*1024*1024||performance.now()-started>=5000)throw budget();
          queryInput.budget?.serialize(result);signal.throwIfAborted();return result;
        } finally {slot.busy=false;}
      });
    };
    return Object.freeze({query,close,budgetProfile});
  } catch { await close();throw unavailable(); }
}
