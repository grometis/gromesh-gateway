import {createHash,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {clusterHistoryFixture} from './cluster-history-fixtures.js';
import {authorizeClusterDelivery,confirmClusterAssociation} from '../../src/analytics/cluster-history.js';
import {IngestionAdmissions} from '../../src/analytics/ingestion-admissions.js';
import {BatchIdentityPolicy} from '../../src/analytics/batch-identity.js';
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
   return{schemaVersion:1 as const,copyId:randomUUID(),podUid,requestId,event:{id,ts,environmentId:f.instanceId,clusterId:producer.source.clusterId,routeId:f.routeId,serviceId:f.serviceId,consumerId:null,method:'GET',path:'/same',status:200,latencyKongMs:1,latencyUpstreamMs:null,latencyTotalMs:2,clientIp:'192.0.2.1',requestSize:'1',responseSize:'1',retentionDays:1}};
  };
  const firstCopies=[await copy()],first=await service.issueIdentity(producer.token,stream.id,firstCopies),admitted=await service.prepareWithIdentity(producer.token,stream.id,first,firstCopies);
  expect(admitted.generation).toBe('1');expect(await service.prepareWithIdentity(producer.token,stream.id,first,firstCopies)).toEqual(admitted);
  const oldId=randomUUID();
  await f.db.transaction(async tx=>{
   await tx.execute(sql`select pg_advisory_xact_lock(1818,1801)`);
   await tx.execute(sql`update analytics_ingestion_counter set position=position+1`);
   await tx.execute(sql`insert into analytics_ingestion_batches(id,stream_id,generation,descriptor,recorded_at) values(${oldId},${stream.id},2,${JSON.stringify([{copyId:randomUUID(),id:randomUUID(),commitment:'a'.repeat(64),expiresAt:'2000-01-01T00:00:00.000Z'}])}::jsonb,clock_timestamp()-interval '8 days')`);
   await audit(tx,producer.ctx,{action:'synthetic.expired-admission',entityType:'ingestion-batch',entityId:oldId});
  });
  expect(await pruneAdmissionHistory(f.db,producer.ctx,1)).toMatchObject({removed:1});
  const freshCopies=[await copy()],fresh=await service.issueIdentity(producer.token,stream.id,freshCopies);
  expect((await service.prepareWithIdentity(producer.token,stream.id,fresh,freshCopies)).generation).toBe('3');
  await expect(legacy.prepare(producer.token,stream.id,randomUUID(),freshCopies)).rejects.toMatchObject({status:409});
  await expect(service.prepareWithIdentity(producer.token,stream.id,fresh,[{...freshCopies[0]!,event:{...freshCopies[0]!.event,status:500}}])).rejects.toMatchObject({status:409});
  const other=await service.open(producer.token,randomUUID());await expect(service.prepareWithIdentity(producer.token,other.id,fresh,[await copy(other.podUid)])).rejects.toMatchObject({status:409});
  const afterRestart=new IngestionAdmissions(f.db,gateway,undefined,new BatchIdentityPolicy(value=>key.fingerprint(value)));
  expect(await afterRestart.prepareWithIdentity(producer.token,stream.id,fresh,freshCopies)).toMatchObject({id:fresh.batchId,generation:'3'});
  const leftCopies=[await copy()],rightCopies=[await copy()],left=await service.issueIdentity(producer.token,stream.id,leftCopies),right=await afterRestart.issueIdentity(producer.token,stream.id,rightCopies);
  const result=await Promise.allSettled([service.prepareWithIdentity(producer.token,stream.id,left,leftCopies),afterRestart.prepareWithIdentity(producer.token,stream.id,right,rightCopies)]);
  expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(result.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect((await f.h.sql.query('select position::text p from analytics_ingestion_counter')).rows[0]!.p).toBe('4');
  const audits=await f.h.sql.query("select after::text value from audit_events where action='analytics.ingestion.identity'");expect(audits.rows.length).toBeGreaterThan(0);expect(JSON.stringify(audits.rows)).not.toContain(fresh.token);expect(JSON.stringify(audits.rows)).not.toContain('192.0.2.1');
 }finally{await f.close();}
});
