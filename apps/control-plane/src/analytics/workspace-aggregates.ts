import {unprocessable} from '../common/problem.js';
import {StorageConsistencyError} from './storage-consistency.js';
import {parseWorkspaceRequestQuery} from './workspace-request-query.js';
export type AggregateOperation='summary'|'timeseries'|'top-routes';
const intervals={'1m':60000,'5m':300000,'15m':900000,'1h':3600000,'1d':86400000} as const;
export interface WorkspaceAggregateQuery{operation:AggregateOperation;from:string;to:string;routeId?:string;serviceId?:string;interval:keyof typeof intervals;by:'requests'|'errors'|'p95';limit:number}
const invalid=(path:string):never=>{throw unprocessable('Invalid workspace analytics query',[{path,message:'is invalid'}]);};
const incomplete=()=>new StorageConsistencyError('analytics-not-ready','Complete attributed request evidence required');
export function parseWorkspaceAggregateQuery(operation:AggregateOperation,raw:Record<string,unknown>,now:number):WorkspaceAggregateQuery{
 const allowed=['from','to','routeId','serviceId',...(operation==='top-routes'?['by','limit']:['interval'])];
 for(const k of Object.keys(raw))if(!allowed.includes(k)||typeof raw[k]!=='string')invalid(k);
 const base=Object.fromEntries(Object.entries(raw).filter(([k])=>['from','to','routeId','serviceId'].includes(k)));
 const q=parseWorkspaceRequestQuery(base,now),interval=raw.interval??'5m',by=raw.by??'requests';
 if(typeof interval!=='string'||!Object.hasOwn(intervals,interval))return invalid('interval');
 const resolution=interval as keyof typeof intervals;
 if(operation!=='top-routes'&&Math.ceil((Date.parse(q.to)-Date.parse(q.from))/intervals[resolution])>2000)return invalid('interval');
 if(typeof by!=='string'||!['requests','errors','p95'].includes(by))return invalid('by');
 const limit=raw.limit===undefined?10:typeof raw.limit==='string'&&/^\d+$/.test(raw.limit)?Number(raw.limit):NaN;
 if(!Number.isInteger(limit)||limit<1||limit>50)return invalid('limit');
 return {operation,from:q.from,to:q.to,...(q.routeId?{routeId:q.routeId}:{}),...(q.serviceId?{serviceId:q.serviceId}:{}),interval:resolution,by:by as WorkspaceAggregateQuery['by'],limit};
}
interface Sample{id:string;routeId:string;serviceId:string|null;status:number;latencyTotalMs:number;ts:string}
const obj=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw incomplete();return v as Record<string,unknown>;};
function stats(rows:readonly Sample[]){
 const requests=rows.length,errors4xx=rows.filter(r=>r.status>=400&&r.status<500).length,errors5xx=rows.filter(r=>r.status>=500).length;
 const latencies=rows.map(r=>r.latencyTotalMs).sort((a,b)=>a-b);
 // Same exact order-statistic definition as the existing quantilesExact(0.5,0.95,0.99) path.
 const at=(p:number)=>latencies.length?latencies[Math.min(latencies.length-1,Math.floor(p*latencies.length))]!:null;
 return {requests,errors4xx,errors5xx,errorRate:requests?(errors4xx+errors5xx)/requests:0,p50Ms:at(.5),p95Ms:at(.95),p99Ms:at(.99)};
}
/** Consumes a complete server-attributed page. It never assigns ownership or merges conflicting copies. */
export function aggregateVerifiedRequestPage(raw:unknown,q:WorkspaceAggregateQuery,names:ReadonlyMap<string,string>=new Map()){
 const page=obj(raw),from=Date.parse(q.from),to=Date.parse(q.to);
 if(page.scope!=='workspace'||page.attributionVersion!=='route-history-v2'||page.retention!=='per-route-1-to-7-days'||page.delivery!=='best-effort'||page.from!==q.from||page.to!==q.to||typeof page.instanceId!=='string'||typeof page.workspaceId!=='string'||typeof page.generatedAt!=='string'||page.nextCursor!==null||!Array.isArray(page.items)||page.items.length>200)throw incomplete();
 const ids=new Set<string>();
 const samples:Sample[]=page.items.map(raw=>{
  const r=obj(raw);
  if(r.workspaceId!==page.workspaceId||r.instanceId!==page.instanceId||typeof r.id!=='string'||ids.has(r.id)||typeof r.routeId!=='string'||(typeof r.serviceId!=='string'&&r.serviceId!==null)||typeof r.ts!=='string'||!Number.isFinite(Date.parse(r.ts))||Date.parse(r.ts)<from||Date.parse(r.ts)>=to||!Number.isInteger(r.status)||Number(r.status)<100||Number(r.status)>599||typeof r.latencyTotalMs!=='number'||!Number.isFinite(r.latencyTotalMs)||r.latencyTotalMs<0)throw incomplete();
  ids.add(r.id);return r as unknown as Sample;
 }).filter(r=>(!q.routeId||r.routeId===q.routeId)&&(!q.serviceId||r.serviceId===q.serviceId));
 const context={scope:'workspace' as const,instanceId:page.instanceId,workspaceId:page.workspaceId,from:q.from,to:q.to,generatedAt:page.generatedAt,attributionVersion:'route-history-v2' as const,retention:'per-route-1-to-7-days' as const,delivery:'best-effort' as const};
 if(q.operation==='top-routes'){
  const grouped=new Map<string,Sample[]>();for(const r of samples){const group=grouped.get(r.routeId)??[];group.push(r);grouped.set(r.routeId,group);}
  const ranked=[...grouped].map(([routeId,rows])=>({routeId,routeName:names.get(routeId)??null,serviceId:new Set(rows.map(r=>r.serviceId)).size===1?rows[0]!.serviceId:null,...stats(rows)}));
  const metric=(r:typeof ranked[number])=>q.by==='requests'?r.requests:q.by==='errors'?r.errors4xx+r.errors5xx:r.p95Ms??-1;
  ranked.sort((a,b)=>metric(b)-metric(a)||b.requests-a.requests||(a.routeId<b.routeId?-1:a.routeId>b.routeId?1:0));
  return {...context,by:q.by,items:ranked.slice(0,q.limit)};
 }
 const size=intervals[q.interval],series=Array.from({length:Math.ceil((to-from)/size)},(_,i)=>({ts:new Date(from+i*size).toISOString(),...stats(samples.filter(r=>Date.parse(r.ts)>=from+i*size&&Date.parse(r.ts)<Math.min(to,from+(i+1)*size)))}));
 return {...context,interval:q.interval,...(q.operation==='summary'?{totals:stats(samples)}:{}),series};
}
