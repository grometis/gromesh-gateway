import 'reflect-metadata';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {Module,RequestMethod,type INestApplication} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {expect,it} from 'vitest';
import {AppModule} from '../../src/app.module.js';
import {APP_CONFIG,type AppConfig} from '../../src/config.js';
import {WorkspaceAnalyticsPreparationModule} from '../../src/analytics/workspace-analytics-preparation.js';
import {createVerifiedWorkspaceRequests} from '../../src/analytics/workspace-request-serving.js';
import {verifiedChain,makeVerifiedCopy} from './verified-ingestion-fixtures.js';
it('serves three contracted aggregations through HTTP using persisted attributed events from two workspaces',()=>verifiedChain(async(f,_reader,producer,copies,streamId,token,admin,settings,pool)=>{
 const original=copies[0]!,extra=[makeVerifiedCopy(f.instanceId,original.event.clusterId,original.podUid,original.event.ts,f.routeId,f.serviceId),makeVerifiedCopy(f.instanceId,original.event.clusterId,original.podUid,original.event.ts,f.routeId,f.serviceId)];
 extra[0]!.event.status=404;extra[0]!.event.latencyTotalMs=10;extra[1]!.event.status=503;extra[1]!.event.latencyTotalMs=30;
 await producer.persist(token,streamId,randomUUID(),extra);
 const serving=await createVerifiedWorkspaceRequests({pool,settings,capacity:1});let app:INestApplication|undefined;
 try{
  @Module({imports:[AppModule.forRoot(f.h.app.get<AppConfig>(APP_CONFIG)),WorkspaceAnalyticsPreparationModule.withServing(serving)]})class TestApp{}
  app=await NestFactory.create(TestApp,{logger:false});app.getHttpAdapter().getInstance().set('query parser','simple');app.setGlobalPrefix('api/v1',{exclude:[{path:'api/v2/{*splat}',method:RequestMethod.ALL}]});await app.init();await app.listen(0,'127.0.0.1');
  const base=(await app.getUrl()).replace('[::1]','127.0.0.1'),cookie=(await f.h.login(f.h.admin.email,f.h.admin.password)).cookie!;
  const params=new URLSearchParams({from:new Date(Date.parse(original.event.ts)-1000).toISOString(),to:new Date().toISOString()});
  const get=async(operation:string,workspaceId=f.workspaceId,query=params,session:string|null=cookie)=>{
   const r=await fetch(`${base}/api/v2/workspaces/${workspaceId}/analytics/${operation}?${query}`,{headers:session?{cookie:session}:{}});return{status:r.status,body:await r.json() as Record<string,unknown>};
  };
  const ajv=new Ajv2020.default({allErrors:true,strict:false});addFormats.default(ajv);
  const contract=JSON.parse(readFileSync(new URL('../../../../contracts/analytics-v2.schemas.json',import.meta.url),'utf8')) as Record<string,unknown>;
  for(const [operation,schema]of[['summary','WorkspaceAnalyticsSummary'],['timeseries','WorkspaceAnalyticsTimeseries'],['top-routes','WorkspaceTopRoutes']]as const){
   expect((await fetch(`${f.base}/api/v2/workspaces/${f.workspaceId}/analytics/${operation}?${params}`,{headers:{cookie}})).status).toBe(404);
   expect((await get(operation,f.workspaceId,params,null)).status).toBe(401);
   const response=await get(operation);expect(response.status).toBe(200);
   const valid=ajv.compile({...contract,$ref:`#/components/schemas/${schema}`});expect(valid(response.body),JSON.stringify(valid.errors)).toBe(true);
   expect(response.body.workspaceId).toBe(f.workspaceId);
   const other=await get(operation,f.otherWorkspaceId);expect(other.status).toBe(200);expect(other.body.workspaceId).toBe(f.otherWorkspaceId);
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
  await producer.prepare(token,streamId,randomUUID(),[{...original,copyId:randomUUID()}]);
  for(const operation of ['summary','timeseries','top-routes']){const r=await get(operation);expect(r.status).toBe(502);expect(r.body).not.toHaveProperty('totals');expect(r.body).not.toHaveProperty('series');expect(r.body).not.toHaveProperty('items');}
 }finally{await app?.close();await serving.close();}
}));
