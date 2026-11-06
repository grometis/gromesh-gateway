import 'reflect-metadata';
import {setImmediate as turn} from 'node:timers/promises';
import {Module,RequestMethod,type INestApplication} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {AppModule} from '../../src/app.module.js';
import {APP_CONFIG,type AppConfig} from '../../src/config.js';
import {WorkspaceRequestPreparationModule} from '../../src/analytics/workspace-request-preparation.js';
import {analyticsHttpContext,observeAnalyticsHttp,type AnalyticsHttpObservation} from '../../src/analytics/analytics-http-observation.js';
import {clusterHistoryFixture} from './cluster-history-fixtures.js';
let f:Awaited<ReturnType<typeof clusterHistoryFixture>>,app:INestApplication,base:string,cookie:string;
const observations:AnalyticsHttpObservation[]=[];
let entered:((signal:AbortSignal)=>void)|undefined;
beforeAll(async()=>{
 f=await clusterHistoryFixture();
 @Module({imports:[AppModule.forRoot(f.h.app.get<AppConfig>(APP_CONFIG)),WorkspaceRequestPreparationModule]})class TestRoot{}
 app=await NestFactory.create(TestRoot,{logger:false});
 // First application middleware, before Nest guards and parameter/query parsing. Not production wiring.
 app.use(observeAnalyticsHttp({onObserved:value=>observations.push(value)}));
 app.use((request:Parameters<typeof analyticsHttpContext>[0],_response:unknown,next:()=>void)=>{const context=analyticsHttpContext(request);if(context)entered?.(context.signal);next();});
 app.getHttpAdapter().getInstance().set('query parser','simple');app.setGlobalPrefix('api/v1',{exclude:[{path:'api/v2/{*splat}',method:RequestMethod.ALL}]});await app.init();await app.listen(0,'127.0.0.1');base=await app.getUrl();cookie=(await f.h.login(f.h.admin.email,f.h.admin.password)).cookie!;
});
afterAll(async()=>{await app?.close();await f?.close();});
function url(extra=''){return `${base}/api/v2/workspaces/${f.workspaceId}/requests?from=${encodeURIComponent(new Date(Date.now()-3600000).toISOString())}&to=${encodeURIComponent(new Date(Date.now()-1000).toISOString())}${extra}`;}
it('observes authorized HTTP including framework completion without claiming positive storage serving',async()=>{
 const r=await fetch(url(),{headers:{cookie}});expect(r.status).toBe(502);expect((await r.json() as {code:string}).code).toBe('analytics-not-ready');const value=observations.at(-1)!;expect(value.completion).toBe('finished');expect(value.elapsedMs).toBeLessThan(8000);expect(value.operationMs).not.toBeNull();expect(value.elapsedMs).toBeGreaterThanOrEqual(value.operationMs!);
});
it('observes invalid parsing and rejected authorization with no operation allocation',async()=>{
 expect((await fetch(url('&unexpected=1'),{headers:{cookie}})).status).toBe(422);expect(observations.at(-1)).toMatchObject({status:422,operationMs:null});expect((await fetch(url())).status).toBe(401);expect(observations.at(-1)).toMatchObject({status:401,operationMs:null});
});
it('counts blocked real authorization SQL in HTTP time and refuses late operation entry after release',async()=>{
 const lock=await f.h.sql.connect();await lock.query('begin');await lock.query('lock table users in access exclusive mode');
 const start=new Promise<AbortSignal>(resolve=>{entered=resolve;});
 const pending=fetch(url(),{headers:{cookie}});let blocked=false;
 try{
  const signal=await start;entered=undefined;
  const until=performance.now()+2000;
  while(performance.now()<until){const rows=await f.h.sql.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike '%users%' and pid<>pg_backend_pid()");if(rows.rowCount){blocked=true;break;}await turn();}
  expect(blocked).toBe(true);
  if(!signal.aborted)await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));
  // The observation does NOT pretend it stopped earlier guard SQL; PostgreSQL still reports the blocked statement.
  expect((await f.h.sql.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike '%users%' and pid<>pg_backend_pid()")).rowCount).toBeGreaterThan(0);
 }finally{entered=undefined;await lock.query('rollback');lock.release();}
 const r=await pending;expect(r.status).toBe(502);expect((await r.json() as {code:string}).code).toBe('analytics-timeout');expect(observations.at(-1)).toMatchObject({completion:'finished',status:502,deadlineExceeded:true,operationMs:null});
});
