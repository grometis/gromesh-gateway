import {expect,it} from 'vitest';
import {aggregateVerifiedRequestPage,parseWorkspaceAggregateQuery} from './workspace-aggregates.js';
const from='2026-01-01T00:00:30.000Z',to='2026-01-01T00:02:00.000Z',now=Date.parse(to),ws='00000000-0000-4000-8000-000000000001',instance='00000000-0000-4000-8000-000000000002',routeA='00000000-0000-4000-8000-000000000003',routeB='00000000-0000-4000-8000-000000000004';
const page=(items:unknown[]=[])=>({scope:'workspace',instanceId:instance,workspaceId:ws,from,to,generatedAt:to,attributionVersion:'route-history-v2',retention:'per-route-1-to-7-days',delivery:'best-effort',items,nextCursor:null});
const row=(id:string,latency=10,status=200,routeId=routeA,ts=from)=>({id,workspaceId:ws,instanceId:instance,ts,routeId,serviceId:routeA,status,latencyTotalMs:latency});
const query=(kind:'summary'|'timeseries'|'top-routes',extra:Record<string,unknown>={})=>parseWorkspaceAggregateQuery(kind,{from,to,...extra},now);
it('computes exact totals, anchored partial buckets and quantiles from a complete attributed request page',()=>{
 const result=aggregateVerifiedRequestPage(page([row('a',10),row('b',20,404),row('c',30,503,routeB,'2026-01-01T00:01:30.000Z')]),query('summary',{interval:'1m'}));
 expect(result).toMatchObject({totals:{requests:3,errors4xx:1,errors5xx:1,errorRate:2/3,p50Ms:20,p95Ms:30,p99Ms:30},series:[{ts:from,requests:2,p50Ms:20},{ts:'2026-01-01T00:01:30.000Z',requests:1}]});
});
it('returns empty buckets and null quantiles for a proven empty page, without inventing collector health',()=>{
 expect(aggregateVerifiedRequestPage(page(),query('timeseries',{interval:'1m'}))).toMatchObject({series:[{requests:0,errorRate:0,p50Ms:null},{requests:0,p95Ms:null}]});
});
it('ranks technical route identities deterministically and does not split a route after a service change',()=>{
 const rows=[row('b',30,503,routeB),row('a',10,404),{...row('c',20),serviceId:routeB}];
 const result=aggregateVerifiedRequestPage(page(rows),query('top-routes'),new Map([[routeA,'Current authorized name']]));
 expect(result).toMatchObject({items:[{routeId:routeA,routeName:'Current authorized name',serviceId:null,requests:2},{routeId:routeB,routeName:null,requests:1}]});
 expect(aggregateVerifiedRequestPage(page([...rows].reverse()),query('top-routes'))).toEqual(aggregateVerifiedRequestPage(page(rows),query('top-routes')));
});
it.each(['summary','timeseries','top-routes'] as const)('refuses a partial page for %s instead of aggregating one page as complete',kind=>{
 expect(()=>aggregateVerifiedRequestPage({...page(),nextCursor:'synthetic'},query(kind))).toThrow();
});
it.each([{workspaceId:routeB},{instanceId:routeB},{latencyTotalMs:-1},{status:700},{ts:to}])('refuses invalid or cross-scope input %j',change=>{
 expect(()=>aggregateVerifiedRequestPage(page([{...row('a'),...change}]),query('summary'))).toThrow();
});
it('refuses duplicate request IDs rather than picking a representative',()=>{expect(()=>aggregateVerifiedRequestPage(page([row('a'),row('a',20)]),query('summary'))).toThrow();});
it.each([{interval:'2m'},{from:'2025-01-01T00:00:00Z'},{status:'500'},{interval:['1m']},{cursor:'injected'},{from:'2026-01-01T00:00:00Z',to:'2026-01-03T00:00:00Z',interval:'1m'}])('rejects invalid summary query %j',extra=>{expect(()=>query('summary',extra)).toThrow();});
it.each([{by:'name'},{limit:'51'},{interval:'1m'}])('rejects invalid ranking query %j',extra=>{expect(()=>query('top-routes',extra)).toThrow();});
it('does not include totals in timeseries or series in ranking responses',()=>{
 expect(aggregateVerifiedRequestPage(page(),query('timeseries'))).not.toHaveProperty('totals');expect(aggregateVerifiedRequestPage(page(),query('top-routes'))).not.toHaveProperty('series');
});
