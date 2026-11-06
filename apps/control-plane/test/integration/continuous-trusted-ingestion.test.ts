import 'reflect-metadata';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
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

it('continues authenticated persistence through three GCs without promoting lost comparison history to HTTP completeness',()=>verifiedChain(async(f,_reader,legacy,copies,streamId,token,admin,settings,pool)=>{
 const key=f.h.app.get<Encryptor>(ENCRYPTOR),gateway=f.h.app.get(AgentGatewayService);
 const reopen=()=>openTrustedIngestion({db:f.db,gateway,settings,experimentalIdentityPolicy:new BatchIdentityPolicy(value=>key.fingerprint(value))});
 let producer=await reopen(),replica:Awaited<ReturnType<typeof reopen>>|undefined;
 let serving=await createVerifiedWorkspaceRequests({pool,settings,capacity:1,budgetProfile:'operational-v1-proposed'}),app:INestApplication|undefined;
 const original=copies[0]!,ctx={actor:{type:'system' as const,id:'synthetic-continuity-gc'},role:'admin' as const,ip:null};
 const fresh=(route=f.routeId,service=f.serviceId,pod=original.podUid)=>makeVerifiedCopy(f.instanceId,original.event.clusterId,pod,original.event.ts,route,service);
 const launch=async()=>{
  @Module({imports:[AppModule.forRoot(f.h.app.get<AppConfig>(APP_CONFIG)),WorkspaceRequestPreparationModule.withServing(serving),WorkspaceAnalyticsPreparationModule.withServing(serving)]})class TestRoot{}
  const root=await NestFactory.create(TestRoot,{logger:false});root.getHttpAdapter().getInstance().set('query parser','simple');root.setGlobalPrefix('api/v1',{exclude:[{path:'api/v2/{*splat}',method:RequestMethod.ALL}]});await root.init();await root.listen(0,'127.0.0.1');return root;
 };
 try{
  await expect(Promise.resolve().then(()=>legacy.issueIdentity(token,streamId,[fresh()]))).rejects.toMatchObject({code:'analytics-not-ready'});
  app=await launch();const cookie=(await f.h.login(f.h.admin.email,f.h.admin.password)).cookie!;
  const bounds=new URLSearchParams({from:new Date(Date.parse(original.event.ts)-1000).toISOString(),to:new Date().toISOString()});
  const get=async(path:string,workspace=f.workspaceId,query=bounds)=>{const r=await fetch(`${await app!.getUrl()}/api/v2/workspaces/${workspace}/${path}?${query}`,{headers:{cookie}});return {status:r.status,body:await r.json() as Record<string,unknown>};};
  const paths=['requests','analytics/summary','analytics/timeseries','analytics/top-routes'];
  let last:Awaited<ReturnType<typeof producer.issueIdentity>>|undefined,lastCopies:ReturnType<typeof fresh>[]=[];
  for(let cycle=0;cycle<3;cycle++){
   const batch=[fresh(),fresh(f.otherRouteId,f.otherServiceId)],identity=await producer.issueIdentity(token,streamId,batch);
   const receipt=await producer.persist(token,streamId,identity.batchId,batch,{identityTicket:identity.token});
   expect(receipt).toMatchObject({batchId:identity.batchId,status:'persisted',storedCopies:2,expiredCopies:0});
   expect(await producer.persist(token,streamId,identity.batchId,batch,{identityTicket:identity.token})).toEqual(receipt);
   await expect(producer.persist(token,streamId,identity.batchId,[{...batch[0]!,event:{...batch[0]!.event,status:500}},batch[1]!],{identityTicket:identity.token})).rejects.toMatchObject({status:409});
   if(cycle===0){
    await admin.command({query:`OPTIMIZE TABLE ${settings.databaseName}.requests_v2_copies FINAL`});
    await admin.command({query:`SYSTEM STOP MERGES ${settings.databaseName}.requests_v2_copies`});
    for(const workspace of [f.workspaceId,f.otherWorkspaceId])for(const path of paths){const response=await get(path,workspace);expect(response.status,path).toBe(200);expect(response.body.workspaceId).toBe(workspace);if(path==='analytics/summary')expect(response.body.totals).toMatchObject({requests:2});}
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
   expect(await pruneAdmissionHistory(f.db,ctx,1)).toEqual({removed:1});expect(await pruneAdmissionHistory(f.db,ctx,1)).toEqual({removed:0});
   await expect(producer.prepareWithIdentity(token,streamId,retired,retiredCopies)).rejects.toMatchObject({status:409});
   for(const path of paths){const response=await get(path);expect(response.status,path).toBe(502);expect(response.body.code).toBe('analytics-not-ready');for(const field of ['items','totals','series'])expect(response.body).not.toHaveProperty(field);}
   last=identity;lastCopies=batch;
   if(cycle===1){
    // Real application/client teardown and recreation, not a claim of OS-process or CH-server restart.
    await app.close();await serving.close();await producer.close();producer=await reopen();serving=await createVerifiedWorkspaceRequests({pool,settings,capacity:1,budgetProfile:'operational-v1-proposed'});app=await launch();
    expect(await producer.persist(token,streamId,identity.batchId,batch,{identityTicket:identity.token})).toEqual(receipt);
   }
  }
  const other=await producer.open(token,randomUUID());await expect(producer.prepareWithIdentity(token,other.id,last!,[fresh(f.routeId,f.serviceId,other.podUid)])).rejects.toMatchObject({status:409});
  await expect(legacy.prepare(token,streamId,randomUUID(),[fresh()])).rejects.toMatchObject({status:409});
  replica=await reopen();const leftCopies=[fresh()],rightCopies=[fresh(f.otherRouteId,f.otherServiceId)];
  const left=await producer.issueIdentity(token,streamId,leftCopies),right=await replica.issueIdentity(token,streamId,rightCopies);
  const outcomes=await Promise.allSettled([producer.persist(token,streamId,left.batchId,leftCopies,{identityTicket:left.token}),replica.persist(token,streamId,right.batchId,rightCopies,{identityTicket:right.token})]);
  expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(r=>r.status==='rejected')).toHaveLength(1);
  const count=await admin.query({query:`SELECT toString(count()) n FROM ${settings.databaseName}.requests_v2_copies`,format:'JSONEachRow'});expect((await count.json<{n:string}>())[0]!.n).toBe('9');
  const conflict={...lastCopies[0]!,copyId:randomUUID(),event:{...lastCopies[0]!.event,status:503,routeId:f.otherRouteId,serviceId:f.otherServiceId}},bad=await producer.issueIdentity(token,streamId,[conflict]);
  await expect(producer.persist(token,streamId,bad.batchId,[conflict],{identityTicket:bad.token})).rejects.toThrow();
  expect((await f.h.sql.query("select count(*)::text n from analytics_copy_evidence where request_id=$1 and kind='conflicting-copies'",[conflict.event.id])).rows[0]!.n).not.toBe('0');
  expect((await f.h.sql.query('select 1 from analytics_ingestion_receipts where batch_id=$1',[bad.batchId])).rowCount).toBe(0);
 }finally{await app?.close();await serving.close();await replica?.close();await producer.close();}
}));
