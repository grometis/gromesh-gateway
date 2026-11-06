import 'reflect-metadata';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {Module,RequestMethod,type INestApplication} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {audit} from '../../src/audit/audit.js';
import {pruneAdmissionHistory} from '../../src/analytics/admission-retention.js';
import {AppModule} from '../../src/app.module.js';
import {APP_CONFIG,type AppConfig} from '../../src/config.js';
import {WorkspaceAnalyticsPreparationModule} from '../../src/analytics/workspace-analytics-preparation.js';
import {WorkspaceRequestPreparationModule} from '../../src/analytics/workspace-request-preparation.js';
import {createVerifiedWorkspaceRequests} from '../../src/analytics/workspace-request-serving.js';
import {verifiedChain,makeVerifiedCopy} from './verified-ingestion-fixtures.js';
it('serves three contracted aggregations through HTTP using persisted attributed events from two workspaces',()=>verifiedChain(async(f,_reader,producer,copies,streamId,token,admin,settings,pool)=>{
 const original=copies[0]!,extra=[makeVerifiedCopy(f.instanceId,original.event.clusterId,original.podUid,original.event.ts,f.routeId,f.serviceId),makeVerifiedCopy(f.instanceId,original.event.clusterId,original.podUid,original.event.ts,f.routeId,f.serviceId)];
 extra[0]!.event.status=404;extra[0]!.event.latencyTotalMs=10;extra[1]!.event.status=503;extra[1]!.event.latencyTotalMs=30;
 await producer.persist(token,streamId,randomUUID(),extra);
 // The positive fixture requires a stable real physical cut. Negative part-mutation tests live in the reader suite.
 // Stop only merges on this freshly owned table; no completeness flag or operational resource is supplied.
 await admin.command({query:`OPTIMIZE TABLE ${settings.databaseName}.requests_v2_copies FINAL`});
 await admin.command({query:`SYSTEM STOP MERGES ${settings.databaseName}.requests_v2_copies`});
 const serving=await createVerifiedWorkspaceRequests({pool,settings,capacity:1});let app:INestApplication|undefined;
 try{
  @Module({imports:[AppModule.forRoot(f.h.app.get<AppConfig>(APP_CONFIG)),WorkspaceAnalyticsPreparationModule.withServing(serving),WorkspaceRequestPreparationModule.withServing(serving)]})class TestApp{}
  app=await NestFactory.create(TestApp,{logger:false});app.getHttpAdapter().getInstance().set('query parser','simple');app.setGlobalPrefix('api/v1',{exclude:[{path:'api/v2/{*splat}',method:RequestMethod.ALL}]});await app.init();await app.listen(0,'127.0.0.1');
  const base=(await app.getUrl()).replace('[::1]','127.0.0.1'),cookie=(await f.h.login(f.h.admin.email,f.h.admin.password)).cookie!;
  const params=new URLSearchParams({from:new Date(Date.parse(original.event.ts)-1000).toISOString(),to:new Date().toISOString()});
  const get=async(operation:string,workspaceId=f.workspaceId,query=params,session:string|null=cookie)=>{
   const path=operation==='requests'?'requests':`analytics/${operation}`;
   const r=await fetch(`${base}/api/v2/workspaces/${workspaceId}/${path}?${query}`,{headers:session?{cookie:session}:{}});return{status:r.status,body:await r.json() as Record<string,unknown>};
  };
  const ajv=new Ajv2020.default({allErrors:true,strict:false});addFormats.default(ajv);
  const contract=JSON.parse(readFileSync(new URL('../../../../contracts/analytics-v2.schemas.json',import.meta.url),'utf8')) as Record<string,unknown>;
  for(const [operation,schema]of[['summary','WorkspaceAnalyticsSummary'],['timeseries','WorkspaceAnalyticsTimeseries'],['top-routes','WorkspaceTopRoutes']]as const){
   expect((await fetch(`${f.base}/api/v2/workspaces/${f.workspaceId}/analytics/${operation}?${params}`,{headers:{cookie}})).status).toBe(404);
   expect((await get(operation,f.workspaceId,params,null)).status).toBe(401);
   const response=await get(operation);expect(response.status,JSON.stringify({operation,code:response.body.code})).toBe(200);
   const valid=ajv.compile({...contract,$ref:`#/components/schemas/${schema}`});expect(valid(response.body),JSON.stringify(valid.errors)).toBe(true);
   expect(response.body.workspaceId).toBe(f.workspaceId);
   const other=await get(operation,f.otherWorkspaceId);expect(other.status,JSON.stringify({operation,code:other.body.code})).toBe(200);expect(other.body.workspaceId).toBe(f.otherWorkspaceId);
   const foreign=new URLSearchParams(params);foreign.set('routeId',f.otherRouteId);expect((await get(operation,f.workspaceId,foreign)).status).toBe(404);
   const invalid=new URLSearchParams(params);invalid.set('sql','unsafe');expect((await get(operation,f.workspaceId,invalid)).status).toBe(422);
  }
  const summary=await get('summary');expect(summary.body.totals).toMatchObject({requests:3,errors4xx:1,errors5xx:1,errorRate:2/3,p50Ms:10,p95Ms:30,p99Ms:30});
  expect((await get('summary',f.otherWorkspaceId)).body.totals).toMatchObject({requests:1,errors4xx:0,errors5xx:0,p95Ms:2});
  expect((await get('top-routes')).body.items).toMatchObject([{routeId:f.routeId,routeName:'fixture-route',serviceId:f.serviceId,requests:3}]);
  // Compare exact order statistics against the actual engine, not a second application implementation.
  const engine=await admin.query({query:`SELECT quantilesExact(0.5,0.95,0.99)(latency_total_ms) q FROM ${settings.databaseName}.requests_v2_copies WHERE route_id={route:UUID}`,query_params:{route:f.routeId},format:'JSONEachRow'});
  expect((await engine.json<{q:number[]}>())[0]!.q).toEqual([10,30,30]);
  const viewer=await f.h.as('viewer'),login=await f.h.login(viewer.email,viewer.password);await f.h.api('PUT',`/users/${viewer.id}/environment-roles`,{items:[{environmentId:f.workspaceId,role:'none'}]});expect((await get('summary',f.workspaceId,params,login.cookie!)).status).toBe(404);
  const duplicate=[{...original,copyId:randomUUID()}],pendingBatch=randomUUID();
  await producer.prepare(token,streamId,pendingBatch,duplicate);
  for(const operation of ['requests','summary','timeseries','top-routes']){const r=await get(operation);expect(r.status).toBe(502);expect(r.body).not.toHaveProperty('totals');expect(r.body).not.toHaveProperty('series');expect(r.body).not.toHaveProperty('items');}
  // Completing and replaying the previously missing batch restores a proven read without double counting.
  await producer.persist(token,streamId,pendingBatch,duplicate);await producer.persist(token,streamId,pendingBatch,duplicate);
  for(const operation of ['requests','summary','timeseries','top-routes']){const recovered=await get(operation);expect(recovered.status,operation).toBe(200);if(operation==='summary')expect(recovered.body.totals).toMatchObject({requests:3,errors4xx:1,errors5xx:1});if(operation==='requests')expect(recovered.body.items).toHaveLength(3);}
  // A later incompatible copy must invalidate every operation, including queries for the other workspace.
  const conflict={...original,copyId:randomUUID(),event:{...original.event,routeId:f.otherRouteId,serviceId:f.otherServiceId,status:500}};
  await expect(producer.persist(token,streamId,randomUUID(),[conflict])).rejects.toThrow();
  for(const operation of ['requests','summary','timeseries','top-routes']){const r=await get(operation,f.otherWorkspaceId);expect(r.status).toBe(502);expect(r.body).not.toHaveProperty('totals');expect(r.body).not.toHaveProperty('series');expect(r.body).not.toHaveProperty('items');}
 }finally{await app?.close();await serving.close();}
}));

it('refuses all four HTTP operations after GC loses admission coverage even while raw ClickHouse copies survive',()=>verifiedChain(async(f,_reader,_producer,copies,streamId,_token,admin,settings,pool)=>{
 await admin.command({query:`OPTIMIZE TABLE ${settings.databaseName}.requests_v2_copies FINAL`});
 await admin.command({query:`SYSTEM STOP MERGES ${settings.databaseName}.requests_v2_copies`});
 const serving=await createVerifiedWorkspaceRequests({pool,settings,capacity:1});let app:INestApplication|undefined;
 try{
  @Module({imports:[AppModule.forRoot(f.h.app.get<AppConfig>(APP_CONFIG)),WorkspaceAnalyticsPreparationModule.withServing(serving),WorkspaceRequestPreparationModule.withServing(serving)]})class TestApp{}
  app=await NestFactory.create(TestApp,{logger:false});app.getHttpAdapter().getInstance().set('query parser','simple');app.setGlobalPrefix('api/v1',{exclude:[{path:'api/v2/{*splat}',method:RequestMethod.ALL}]});await app.init();await app.listen(0,'127.0.0.1');
  const base=(await app.getUrl()).replace('[::1]','127.0.0.1'),cookie=(await f.h.login(f.h.admin.email,f.h.admin.password)).cookie!;
  const params=new URLSearchParams({from:new Date(Date.parse(copies[0]!.event.ts)-1000).toISOString(),to:new Date().toISOString()});
  const paths=['requests','analytics/summary','analytics/timeseries','analytics/top-routes'];
  const get=async(path:string)=>{const response=await fetch(`${base}/api/v2/workspaces/${f.workspaceId}/${path}?${params}`,{headers:{cookie}});return{status:response.status,body:await response.json() as Record<string,unknown>};};
  for(const path of paths)expect((await get(path)).status,path).toBe(200);
  const id=randomUUID(),ctx={actor:{type:'system' as const,id:'synthetic-expired-http-admission'},role:'admin' as const,ip:null};
  // Only the expired technical descriptor is synthetic; pruning and both database reads are real.
  await f.db.transaction(async tx=>{
   await tx.execute(sql`select pg_advisory_xact_lock(1818,1801)`);
   const counter=(await tx.execute<{position:string}>(sql`update analytics_ingestion_counter set position=position+1 returning position::text`)).rows[0]!;
   await tx.execute(sql`insert into analytics_ingestion_batches(id,stream_id,generation,descriptor,recorded_at) values(${id},${streamId},${counter.position}::bigint,${JSON.stringify([{copyId:randomUUID(),id:randomUUID(),commitment:'a'.repeat(64),expiresAt:'2000-01-01T00:00:00.000Z'}])}::jsonb,clock_timestamp()-interval '8 days')`);
   await audit(tx,ctx,{action:'synthetic.expired-http-admission',entityType:'ingestion-batch',entityId:id});
  });
  expect(await pruneAdmissionHistory(f.db,ctx,1)).toEqual({removed:1});expect(await pruneAdmissionHistory(f.db,ctx,1)).toEqual({removed:0});
  const count=await admin.query({query:`SELECT toString(count()) n FROM ${settings.databaseName}.requests_v2_copies`,format:'JSONEachRow'});expect((await count.json<{n:string}>())[0]!.n).toBe('2');
  for(const path of paths){const response=await get(path);expect(response.status,path).toBe(502);for(const field of ['items','totals','series'])expect(response.body).not.toHaveProperty(field);}
 }finally{await app?.close();await serving.close();}
}));
