import 'reflect-metadata';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {drizzle} from 'drizzle-orm/node-postgres';
import * as schema from '../../src/db/schema.js';
import {Module,RequestMethod,type INestApplication} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {expect,it} from 'vitest';
import {AppModule} from '../../src/app.module.js';
import {APP_CONFIG,type AppConfig} from '../../src/config.js';
import {ENCRYPTOR,Encryptor} from '../../src/crypto/crypto.js';
import {AgentGatewayService} from '../../src/agent-gateway/agent-gateway.js';
import {audit} from '../../src/audit/audit.js';
import {BatchIdentityPolicy} from '../../src/analytics/batch-identity.js';
import {pruneAdmissionHistory} from '../../src/analytics/admission-retention.js';
import {openTrustedIngestion} from '../../src/analytics/trusted-ingestion.js';
import {createVerifiedWorkspaceRequests} from '../../src/analytics/workspace-request-serving.js';
import {WorkspaceRequestPreparationModule} from '../../src/analytics/workspace-request-preparation.js';
import {WorkspaceAnalyticsPreparationModule} from '../../src/analytics/workspace-analytics-preparation.js';
import {verifiedChain,makeVerifiedCopy} from './verified-ingestion-fixtures.js';
import {assertIntegrationDatabase} from './databases.js';
import {createAnalyticsTestProcess} from './analytics-test-process.js';
import {observeAnalyticsHttp,type AnalyticsHttpObservation} from '../../src/analytics/analytics-http-observation.js';

it('continues authenticated persistence through three GCs without promoting lost comparison history to HTTP completeness',()=>verifiedChain(async(f,_reader,legacy,copies,streamId,token,admin,settings,pool)=>{
 const key=f.h.app.get<Encryptor>(ENCRYPTOR),gateway=f.h.app.get(AgentGatewayService);
 const runtimeDb=drizzle(pool,{schema});
 const reopen=()=>openTrustedIngestion({db:runtimeDb,gateway,settings,experimentalIdentityPolicy:new BatchIdentityPolicy(value=>key.fingerprint(value))});
 let producer=await reopen();
 let worker:Awaited<ReturnType<typeof createAnalyticsTestProcess>>|undefined;
 const observations:AnalyticsHttpObservation[]=[];
 let serving=await createVerifiedWorkspaceRequests({pool,settings,capacity:1,budgetProfile:'operational-v1-proposed'}),app:INestApplication|undefined;
 const original=copies[0]!,ctx={actor:{type:'system' as const,id:'synthetic-continuity-gc'},role:'admin' as const,ip:null};
 const fresh=(route=f.routeId,service=f.serviceId,pod=original.podUid)=>makeVerifiedCopy(f.instanceId,original.event.clusterId,pod,original.event.ts,route,service);
 const launch=async()=>{
  @Module({imports:[AppModule.forRoot(f.h.app.get<AppConfig>(APP_CONFIG)),WorkspaceRequestPreparationModule.withServing(serving),WorkspaceAnalyticsPreparationModule.withServing(serving)]})class TestRoot{}
  const root=await NestFactory.create(TestRoot,{logger:false});root.use(observeAnalyticsHttp({onObserved:value=>observations.push(value)}));root.getHttpAdapter().getInstance().set('query parser','simple');root.setGlobalPrefix('api/v1',{exclude:[{path:'api/v2/{*splat}',method:RequestMethod.ALL}]});await root.init();await root.listen(0,'127.0.0.1');return root;
 };
 try{
  expect(Reflect.has(legacy,'issueIdentity')).toBe(false);expect(Reflect.has(legacy,'prepareWithIdentity')).toBe(false);
  await expect(openTrustedIngestion({db:f.db,gateway,settings,experimentalIdentityPolicy:new BatchIdentityPolicy(value=>key.fingerprint(value))})).rejects.toMatchObject({code:'analytics-not-ready'});
  app=await launch();const cookie=(await f.h.login(f.h.admin.email,f.h.admin.password)).cookie!;
  const bounds=new URLSearchParams({from:new Date(Date.parse(original.event.ts)-1000).toISOString(),to:new Date().toISOString()});
  const get=async(path:string,workspace=f.workspaceId,query=bounds)=>{const r=await fetch(`${await app!.getUrl()}/api/v2/workspaces/${workspace}/${path}?${query}`,{headers:{cookie}});return {status:r.status,body:await r.json() as Record<string,unknown>};};
  const paths=['requests','analytics/summary','analytics/timeseries','analytics/top-routes'];
  let last:Awaited<ReturnType<typeof producer.issueIdentity>>|undefined,lastCopies:ReturnType<typeof fresh>[]=[];
  for(let cycle=0;cycle<3;cycle++){
   const batch=[fresh(),fresh(f.otherRouteId,f.otherServiceId)],identity=await producer.issueIdentity(token,streamId,batch);
   const receipt=await producer.persist(token,streamId,identity.batchId,batch,{identityTicket:identity.token});
   expect(receipt).toMatchObject({batchId:identity.batchId,generation:String(cycle*2+2),status:'persisted',storedCopies:2,expiredCopies:0});
   expect((await f.h.sql.query('select r.stored_copies stored,r.expired_copies expired,w.state from analytics_ingestion_receipts r join analytics_ingestion_workers w on w.batch_id=r.batch_id where r.batch_id=$1',[identity.batchId])).rows).toEqual([{stored:2,expired:0,state:'verified'}]);
   expect(await producer.persist(token,streamId,identity.batchId,batch,{identityTicket:identity.token})).toEqual(receipt);
   await expect(producer.persist(token,streamId,identity.batchId,[{...batch[0]!,event:{...batch[0]!.event,status:500}},batch[1]!],{identityTicket:identity.token})).rejects.toMatchObject({status:409});
   if(cycle===0){
    await admin.command({query:`OPTIMIZE TABLE ${settings.databaseName}.requests_v2_copies FINAL`});
    await admin.command({query:`SYSTEM STOP MERGES ${settings.databaseName}.requests_v2_copies`});
    for(const workspace of [f.workspaceId,f.otherWorkspaceId])for(const path of paths){const response=await get(path,workspace);expect(response.status,path).toBe(200);expect(response.body.workspaceId).toBe(workspace);if(path==='analytics/summary')expect(response.body.totals).toMatchObject({requests:2});if(path==='requests'){const items=response.body.items as Record<string,unknown>[];expect(items).toHaveLength(2);for(const item of items)expect(item).toMatchObject({workspaceId:workspace,routeId:workspace===f.workspaceId?f.routeId:f.otherRouteId,effectiveRevision:null});}}
    for(const workspace of [f.workspaceId,f.otherWorkspaceId]){
     const page=await get('requests',workspace),summary=await get('analytics/summary',workspace),series=await get('analytics/timeseries',workspace),top=await get('analytics/top-routes',workspace);
     const count=(page.body.items as unknown[]).length;expect((summary.body.totals as {requests:number}).requests).toBe(count);expect((series.body.series as {requests:number}[]).reduce((n,row)=>n+row.requests,0)).toBe(count);expect((top.body.items as {requests:number}[]).reduce((n,row)=>n+row.requests,0)).toBe(count);
    }
    const query=new URLSearchParams(bounds);query.set('limit','1');const page=await get('requests',f.workspaceId,query);expect(page.body.nextCursor).toEqual(expect.any(String));query.set('cursor',page.body.nextCursor as string);const next=await get('requests',f.workspaceId,query);expect(next.status).toBe(200);expect(next.body.nextCursor).toBeNull();
   }
   const retiredCopies=[fresh()],retired=await producer.issueIdentity(token,streamId,retiredCopies);
   // Synthetic expired technical marker: no old producer authentication or physical persistence is claimed.
   await f.db.transaction(async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(1818,1801)`);
    const position=(await tx.execute<{position:string}>(sql`update analytics_ingestion_counter set position=position+1 returning position::text`)).rows[0]!.position;
    await tx.execute(sql`insert into analytics_ingestion_batches(id,stream_id,generation,descriptor,recorded_at) values(${retired.batchId},${streamId},${position}::bigint,${JSON.stringify([{copyId:randomUUID(),id:randomUUID(),commitment:'a'.repeat(64),expiresAt:'2000-01-01T00:00:00.000Z'}])}::jsonb,clock_timestamp()-interval '8 days')`);
    await audit(tx,ctx,{action:'synthetic.expired-continuity-marker',entityType:'ingestion-batch',entityId:retired.batchId});
   });
   expect((await f.h.sql.query('select count(*)::int n from analytics_ingestion_batches')).rows[0]!.n).toBe(cycle+3);
   const beforeGc=(await f.h.sql.query('select position::text p from analytics_ingestion_counter')).rows[0]!.p;
   expect(await pruneAdmissionHistory(f.db,ctx,1)).toEqual({removed:1});expect(await pruneAdmissionHistory(f.db,ctx,1)).toEqual({removed:0});
   expect((await f.h.sql.query('select position::text p from analytics_ingestion_counter')).rows[0]!.p).toBe(beforeGc);expect((await f.h.sql.query('select count(*)::int n from analytics_ingestion_batches')).rows[0]!.n).toBe(cycle+2);
   await expect(producer.prepareWithIdentity(token,streamId,retired,retiredCopies)).rejects.toMatchObject({status:409});
   for(const path of paths){const response=await get(path);expect(response.status,path).toBe(502);expect(response.body.code).toBe('analytics-not-ready');for(const field of ['items','totals','series'])expect(response.body).not.toHaveProperty(field);}
   last=identity;lastCopies=batch;
   if(cycle===1){
    // Real application/client teardown and recreation, not a claim of OS-process or CH-server restart.
    await app.close();await serving.close();await producer.close();producer=await reopen();serving=await createVerifiedWorkspaceRequests({pool,settings,capacity:1,budgetProfile:'operational-v1-proposed'});app=await launch();
    expect(await producer.persist(token,streamId,identity.batchId,batch,{identityTicket:identity.token})).toEqual(receipt);
   }
  }
  // Parent fixture proves ownership; the child additionally validates names/URLs and its registered runtime role.
  const config=f.h.app.get<AppConfig>(APP_CONFIG);assertIntegrationDatabase(config.databaseUrl);expect(config.databaseUrl).toBe(f.url);
  const boot={config,runtimeUrl:pool.options.connectionString,settings};expect(typeof boot.runtimeUrl).toBe('string');
  worker=await createAnalyticsTestProcess();await worker.call('boot',boot);
  const recoveredCopies=[fresh(),fresh(f.otherRouteId,f.otherServiceId)],identity=await worker.call<{batchId:string;token:string}>('mint',{token,streamId,copies:recoveredCopies});
  const persisted=await worker.call('persist',{token,streamId,identity,copies:recoveredCopies});expect(persisted).toMatchObject({batchId:identity.batchId,status:'persisted',storedCopies:2});
  const oldPid=worker.pid;await worker.close(true);expect(worker.exited()).toBe(true);
  worker=await createAnalyticsTestProcess();expect(worker.pid).not.toBe(oldPid);const restarted=await worker.call<{url:string}>('boot',boot);
  expect(await worker.call('persist',{token,streamId,identity,copies:recoveredCopies})).toEqual(persisted);
  for(const workspace of [f.workspaceId,f.otherWorkspaceId])for(const path of paths){const response=await fetch(`${restarted.url}/api/v2/workspaces/${workspace}/${path}?${bounds}`,{headers:{cookie}});expect(response.status).toBe(502);const body=await response.json() as Record<string,unknown>;expect(body.code).toBe('analytics-not-ready');for(const field of ['items','totals','series'])expect(body).not.toHaveProperty(field);}
  const childObserved=await worker.call<AnalyticsHttpObservation[]>('observations');expect(childObserved).toHaveLength(8);expect(childObserved.every(value=>value.completion==='finished'&&!value.deadlineExceeded)).toBe(true);
  const other=await producer.open(token,randomUUID());await expect(producer.prepareWithIdentity(token,other.id,last!,[fresh(f.routeId,f.serviceId,other.podUid)])).rejects.toMatchObject({status:409});
  await expect(legacy.prepare(token,streamId,randomUUID(),[fresh()])).rejects.toMatchObject({status:409});
  const leftCopies=[fresh()],rightCopies=[fresh(f.otherRouteId,f.otherServiceId)];
  const left=await producer.issueIdentity(token,streamId,leftCopies),right=await worker.call<{batchId:string;token:string}>('mint',{token,streamId,copies:rightCopies});
  const outcomes=await Promise.allSettled([producer.persist(token,streamId,left.batchId,leftCopies,{identityTicket:left.token}),worker.call('persist',{token,streamId,identity:right,copies:rightCopies})]);
  expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(r=>r.status==='rejected')).toHaveLength(1);
  const loser=outcomes.findIndex(r=>r.status==='rejected');expect((outcomes[loser] as PromiseRejectedResult).reason).toMatchObject({status:409});
  const rejectedId=[left.batchId,right.batchId][loser]!;
  expect((await f.h.sql.query('select 1 from analytics_ingestion_batches where id=$1',[rejectedId])).rowCount).toBe(0);
  expect((await f.h.sql.query('select 1 from analytics_ingestion_receipts where batch_id=$1',[rejectedId])).rowCount).toBe(0);
  const count=await admin.query({query:`SELECT toString(count()) n FROM ${settings.databaseName}.requests_v2_copies`,format:'JSONEachRow'});expect((await count.json<{n:string}>())[0]!.n).toBe('11');
  const conflict={...lastCopies[0]!,copyId:randomUUID(),event:{...lastCopies[0]!.event,status:503,routeId:f.otherRouteId,serviceId:f.otherServiceId}},bad=await producer.issueIdentity(token,streamId,[conflict]);
  await expect(producer.persist(token,streamId,bad.batchId,[conflict],{identityTicket:bad.token})).rejects.toThrow();
  expect((await f.h.sql.query("select count(*)::text n from analytics_copy_evidence where request_id=$1 and kind='conflicting-copies'",[conflict.event.id])).rows[0]!.n).not.toBe('0');
  expect((await f.h.sql.query('select 1 from analytics_ingestion_receipts where batch_id=$1',[bad.batchId])).rowCount).toBe(0);
  expect(observations.every(value=>value.completion==='finished'&&!value.deadlineExceeded)).toBe(true);
 }finally{await worker?.close();await app?.close();await serving.close();await producer.close();}
}));
