import {createHash,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {clusterHistoryFixture} from './cluster-history-fixtures.js';
import {authorizeClusterDelivery,confirmClusterAssociation,revokeClusterAssociation} from '../../src/analytics/cluster-history.js';
import {IngestionCopyPersistence} from '../../src/analytics/ingestion-copy-persistence.js';
import type {ClickHouseClient} from '@clickhouse/client';
import {IngestionAdmissions} from '../../src/analytics/ingestion-admissions.js';
import {BatchIdentityPolicy,digestAdmissionDescriptor} from '../../src/analytics/batch-identity.js';
import {AgentGatewayService} from '../../src/agent-gateway/agent-gateway.js';
import {ENCRYPTOR,Encryptor} from '../../src/crypto/crypto.js';
import {pruneAdmissionHistory} from '../../src/analytics/admission-retention.js';
import {audit} from '../../src/audit/audit.js';
it('admits new signed identities after real GC without resurrecting consumed positions or changing legacy rules',async()=>{
 const f=await clusterHistoryFixture();
 try{
  const producer=await f.registered(),auth=await f.db.transaction(tx=>authorizeClusterDelivery(tx,producer.ctx,producer.source));await confirmClusterAssociation(f.db,auth);
  const key=f.h.app.get<Encryptor>(ENCRYPTOR),policy=new BatchIdentityPolicy(value=>key.fingerprint(value)),gateway=f.h.app.get(AgentGatewayService),service=new IngestionAdmissions(f.db,gateway,undefined,policy),legacy=new IngestionAdmissions(f.db,gateway);
  const stream=await service.open(producer.token,randomUUID());
  const copy=async(podUid=stream.podUid)=>{
   const requestId=randomUUID().replaceAll('-',''),h=createHash('sha256').update(`${producer.source.clusterId}|${podUid}|${requestId}`).digest('hex').slice(0,32);
   const id=`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`,ts=(await f.h.sql.query("select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') ts")).rows[0]!.ts as string;
   return{schemaVersion:1 as const,copyId:randomUUID(),podUid,requestId,event:{id,ts,environmentId:f.instanceId,clusterId:producer.source.clusterId,routeId:f.routeId,serviceId:f.serviceId,consumerId:null,method:'GET',path:'/same',status:200,latencyKongMs:1,latencyUpstreamMs:null,latencyTotalMs:2,clientIp:'::ffff:192.0.2.1',requestSize:'1',responseSize:'1',retentionDays:1}};
  };
  await expect(service.prepareWithIdentity(producer.token,stream.id,{batchId:randomUUID(),token:''},[await copy()])).rejects.toMatchObject({status:409});
  const firstCopies=[await copy()],first=await service.issueIdentity(producer.token,stream.id,firstCopies),admitted=await service.prepareWithIdentity(producer.token,stream.id,first,firstCopies);
  expect(admitted.generation).toBe('1');expect(await service.prepareWithIdentity(producer.token,stream.id,first,firstCopies)).toEqual(admitted);
  const oldCopies=[await copy()],oldIdentity=await service.issueIdentity(producer.token,stream.id,oldCopies),oldId=oldIdentity.batchId;
  // Artificially aged technical descriptor exercises loss of a signed UUID binding, not past producer authorization.
  // The signed envelope itself is current/valid; replay must fail because its position was consumed, not because UUID history survives.
  await f.db.transaction(async tx=>{
   await tx.execute(sql`select pg_advisory_xact_lock(1818,1801)`);
   await tx.execute(sql`update analytics_ingestion_counter set position=position+1`);
   await tx.execute(sql`insert into analytics_ingestion_batches(id,stream_id,generation,descriptor,recorded_at) values(${oldId},${stream.id},2,${JSON.stringify([{copyId:randomUUID(),id:randomUUID(),commitment:'a'.repeat(64),expiresAt:'2000-01-01T00:00:00.000Z'}])}::jsonb,clock_timestamp()-interval '8 days')`);
   await audit(tx,producer.ctx,{action:'synthetic.expired-admission',entityType:'ingestion-batch',entityId:oldId});
  });
  expect(await pruneAdmissionHistory(f.db,producer.ctx,1)).toMatchObject({removed:1});
  expect((await f.h.sql.query('select 1 from analytics_ingestion_batches where id=$1',[oldId])).rowCount).toBe(0);
  await expect(service.prepareWithIdentity(producer.token,stream.id,oldIdentity,oldCopies)).rejects.toMatchObject({status:409});
  const freshCopies=[await copy()],fresh=await service.issueIdentity(producer.token,stream.id,freshCopies);
  const spareCopies=[await copy()],spare=await service.issueIdentity(producer.token,stream.id,spareCopies);
  expect((await service.prepareWithIdentity(producer.token,stream.id,fresh,freshCopies)).generation).toBe('3');
  const descriptor=(await f.h.sql.query('select descriptor from analytics_ingestion_batches where id=$1',[fresh.batchId])).rows[0]!.descriptor as {copyId:string;id:string;commitment:string;expiresAt:string}[];
  const clock=(await f.h.sql.query('select floor(extract(epoch from clock_timestamp())*1000)::text ms')).rows[0]!.ms as string;
  // A correctly signed but expired envelope must fail at the actual PostgreSQL admission boundary.
  const expired=policy.issue({instanceId:f.instanceId,streamId:stream.id,authorizationId:stream.authorizationId,position:'3',descriptorDigest:digestAdmissionDescriptor(descriptor)},Number(clock)-900000);
  await expect(service.prepareWithIdentity(producer.token,stream.id,expired,freshCopies)).rejects.toMatchObject({status:409});
  expect((await f.h.sql.query('select position::text p from analytics_ingestion_counter')).rows[0]!.p).toBe('3');
  expect((await f.h.sql.query('select 1 from analytics_ingestion_batches where id=$1',[expired.batchId])).rowCount).toBe(0);
  await expect(legacy.prepare(producer.token,stream.id,randomUUID(),freshCopies)).rejects.toMatchObject({status:409});
  await expect(service.prepareWithIdentity(producer.token,stream.id,fresh,[{...freshCopies[0]!,event:{...freshCopies[0]!.event,status:500}}])).rejects.toMatchObject({status:409});
  const other=await service.open(producer.token,randomUUID());await expect(service.prepareWithIdentity(producer.token,other.id,fresh,[await copy(other.podUid)])).rejects.toMatchObject({status:409});
  const afterRestart=new IngestionAdmissions(f.db,gateway,undefined,new BatchIdentityPolicy(value=>key.fingerprint(value)));
  expect(await afterRestart.prepareWithIdentity(producer.token,stream.id,fresh,freshCopies)).toMatchObject({id:fresh.batchId,generation:'3'});
  const leftCopies=[await copy()],rightCopies=[await copy()],left=await service.issueIdentity(producer.token,stream.id,leftCopies),right=await afterRestart.issueIdentity(producer.token,stream.id,rightCopies);
  const result=await Promise.allSettled([service.prepareWithIdentity(producer.token,stream.id,left,leftCopies),afterRestart.prepareWithIdentity(producer.token,stream.id,right,rightCopies)]);
  expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(result.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect((await f.h.sql.query('select position::text p from analytics_ingestion_counter')).rows[0]!.p).toBe('4');
  // Persistence is replaced ONLY to inspect the boundary and deliberately fail, never to fabricate a receipt.
  const capture=new IngestionCopyPersistence({} as ClickHouseClient,{} as ClickHouseClient);let observedStatus:unknown;
  capture.persist=async input=>{observedStatus=input.copies[0]!.event.status;throw Error('synthetic boundary stop');};
  const signedPersist=new IngestionAdmissions(f.db,gateway,capture,policy),payload=[await copy()],identity=await signedPersist.issueIdentity(producer.token,stream.id,payload);
  const gate=await f.h.sql.connect();await gate.query('select pg_advisory_lock(1818,1801)');
  const pending=signedPersist.persist(producer.token,stream.id,identity.batchId,payload,{identityTicket:identity.token}).then(()=>null,error=>error as unknown);
  try{payload[0]!.event.status=500;}finally{await gate.query('select pg_advisory_unlock(1818,1801)');gate.release();}
  expect(await pending).toMatchObject({message:'synthetic boundary stop'});expect(observedStatus).toBe(200);
  const audits=await f.h.sql.query("select after::text value from audit_events where action='analytics.ingestion.identity'");expect(audits.rows.length).toBeGreaterThan(0);expect(JSON.stringify(audits.rows)).not.toContain(fresh.token);expect(JSON.stringify(audits.rows)).not.toContain('192.0.2.1');
  // A surviving live batch also proves a counter-only restore is stale, even exactly at prune coverage.
  const frontier=(await f.h.sql.query('select pruned_through::text p from analytics_ingestion_prune_coverage')).rows[0]!.p;
  await f.h.sql.query('update analytics_ingestion_counter set position=$1',[frontier]);
  expect(await service.prepareWithIdentity(producer.token,stream.id,spare,spareCopies).then(()=>null,error=>({status:(error as {status:number}).status}))).toEqual({status:409});
  expect((await f.h.sql.query('select position::text p from analytics_ingestion_counter')).rows[0]!.p).toBe(frontier);
  expect(await service.issueIdentity(producer.token,stream.id,oldCopies).then(()=>null,error=>({status:(error as {status:number}).status}))).toEqual({status:409});
  // Simulate a partial restore losing the counter while irreversible prune coverage survived.
  await f.h.sql.query('update analytics_ingestion_counter set position=1');
  expect(await service.issueIdentity(producer.token,stream.id,oldCopies).then(()=>null,error=>({status:(error as {status:number}).status}))).toEqual({status:409});
  await expect(service.prepareWithIdentity(producer.token,stream.id,oldIdentity,oldCopies)).rejects.toMatchObject({status:409});
 }finally{await f.close();}
});

it('continues admission across three bounded GC cycles while rejecting stale tickets and revoked authority',async()=>{
 const f=await clusterHistoryFixture();
 try{
  const producer=await f.registered(),auth=await f.db.transaction(tx=>authorizeClusterDelivery(tx,producer.ctx,producer.source));await confirmClusterAssociation(f.db,auth);
  const key=f.h.app.get<Encryptor>(ENCRYPTOR),gateway=f.h.app.get(AgentGatewayService),policy=new BatchIdentityPolicy(value=>key.fingerprint(value));
  const replica=()=>new IngestionAdmissions(f.db,gateway,undefined,new BatchIdentityPolicy(value=>key.fingerprint(value)));
  let service=replica();const stream=await service.open(producer.token,randomUUID());
  const copy=async()=>{
   const requestId=randomUUID().replaceAll('-',''),h=createHash('sha256').update(`${producer.source.clusterId}|${stream.podUid}|${requestId}`).digest('hex').slice(0,32),ts=(await f.h.sql.query("select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') ts")).rows[0]!.ts as string;
   return{schemaVersion:1 as const,copyId:randomUUID(),podUid:stream.podUid,requestId,event:{id:`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`,ts,environmentId:f.instanceId,clusterId:producer.source.clusterId,routeId:f.routeId,serviceId:f.serviceId,consumerId:null,method:'GET',path:'/same',status:200,latencyKongMs:1,latencyUpstreamMs:null,latencyTotalMs:2,clientIp:'::ffff:192.0.2.1',requestSize:'1',responseSize:'1',retentionDays:1}};
  };
  for(let cycle=0;cycle<3;cycle++){
   const copies=[await copy()],identity=await service.issueIdentity(producer.token,stream.id,copies);
   const expected=String(cycle*2+1);expect(await service.prepareWithIdentity(producer.token,stream.id,identity,copies)).toMatchObject({generation:expected});
   service=replica();expect(await service.prepareWithIdentity(producer.token,stream.id,identity,copies)).toMatchObject({generation:expected});
   const retiredCopies=[await copy()],retired=await service.issueIdentity(producer.token,stream.id,retiredCopies);
   // Expired technical markers advance the real GC; no old producer authentication or persistence is fabricated.
   await f.db.transaction(async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(1818,1801)`);await tx.execute(sql`update analytics_ingestion_counter set position=position+1`);
    await tx.execute(sql`insert into analytics_ingestion_batches(id,stream_id,generation,descriptor,recorded_at) values(${retired.batchId},${stream.id},${cycle*2+2},${JSON.stringify([{copyId:randomUUID(),id:randomUUID(),commitment:'a'.repeat(64),expiresAt:'2000-01-01T00:00:00.000Z'}])}::jsonb,clock_timestamp()-interval '8 days')`);
    await audit(tx,producer.ctx,{action:'synthetic.expired-cycle',entityType:'ingestion-batch',entityId:retired.batchId});
   });
   expect(await pruneAdmissionHistory(f.db,producer.ctx,1)).toEqual({removed:1});expect(await pruneAdmissionHistory(f.db,producer.ctx,1)).toEqual({removed:0});
   await expect(service.prepareWithIdentity(producer.token,stream.id,retired,retiredCopies)).rejects.toMatchObject({status:409});
   expect(await service.prepareWithIdentity(producer.token,stream.id,identity,copies)).toMatchObject({generation:expected});
   expect((await f.h.sql.query('select position::text position from analytics_ingestion_counter')).rows[0]!.position).toBe(String(cycle*2+2));
  }
  const copies=[await copy()],identity=await service.issueIdentity(producer.token,stream.id,copies);
  const second=replica(),otherCopies=[await copy()],other=await second.issueIdentity(producer.token,stream.id,otherCopies);
  const outcomes=await Promise.allSettled([service.prepareWithIdentity(producer.token,stream.id,identity,copies),second.prepareWithIdentity(producer.token,stream.id,other,otherCopies)]);
  expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect((await f.h.sql.query('select position::text position from analytics_ingestion_counter')).rows[0]!.position).toBe('7');
  const lastCopies=[await copy()],last=await service.issueIdentity(producer.token,stream.id,lastCopies);
  await f.db.transaction(tx=>revokeClusterAssociation(tx,{actor:{type:'system',id:'r23-synthetic-lifecycle'},role:'admin',ip:null},producer.source.clusterId,'revoke'));
  await expect(service.prepareWithIdentity(producer.token,stream.id,last,lastCopies)).rejects.toMatchObject({status:401});
  await expect(service.issueIdentity(producer.token,stream.id,lastCopies)).rejects.toMatchObject({status:401});
  expect((await f.h.sql.query('select position::text position from analytics_ingestion_counter')).rows[0]!.position).toBe('7');
 }finally{await f.close();}
});
