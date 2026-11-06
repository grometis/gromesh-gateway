import { integrationInputs } from "../../../../scripts/integration-databases.mjs";
import { encodeRawRequestCopy } from "../../src/analytics/request-copy-store.js";
import { createClient } from "@clickhouse/client";
import { IngestionCopyPersistence } from "../../src/analytics/ingestion-copy-persistence.js";
import { CLICKHOUSE, CLICKHOUSE_ADMIN } from "./harness.js";
import { createHash, randomUUID } from "node:crypto";
import { beforeAll, afterAll, expect, it } from "vitest";
import { IngestionAdmissions } from "../../src/analytics/ingestion-admissions.js";
import { AgentGatewayService } from "../../src/agent-gateway/agent-gateway.js";
import { authorizeClusterDelivery, confirmClusterAssociation, revokeClusterAssociation } from "../../src/analytics/cluster-history.js";
import { clusterHistoryFixture } from "./cluster-history-fixtures.js";
let f:Awaited<ReturnType<typeof clusterHistoryFixture>>,producer:Awaited<ReturnType<Awaited<ReturnType<typeof clusterHistoryFixture>>["registered"]>>,admissions:IngestionAdmissions;
const writer=createClient({url:CLICKHOUSE_ADMIN.url,database:CLICKHOUSE_ADMIN.database,username:CLICKHOUSE_ADMIN.user,password:CLICKHOUSE_ADMIN.password});
const reader=createClient({url:CLICKHOUSE.url,database:CLICKHOUSE.database,username:CLICKHOUSE.user,password:CLICKHOUSE.password});
const podUid="00000000-0000-4000-8000-000000001818";
beforeAll(async()=>{f=await clusterHistoryFixture();producer=await f.registered();const id=await f.db.transaction(tx=>authorizeClusterDelivery(tx,producer.ctx,producer.source));await confirmClusterAssociation(f.db,id);admissions=new IngestionAdmissions(f.db,f.h.app.get(AgentGatewayService),new IngestionCopyPersistence(writer,reader));});
afterAll(async()=>{await f?.close();await writer.close();await reader.close();});
async function copy(){const requestId=randomUUID().replaceAll("-","");const hex=createHash("sha256").update(producer.source.clusterId+"|"+podUid+"|"+requestId).digest("hex").slice(0,32);const id=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
const ts=(await f.h.sql.query<{ts:string}>(`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ts`)).rows[0]!.ts;
return {schemaVersion:1 as const,copyId:randomUUID(),podUid,requestId,event:{id,ts,environmentId:f.instanceId,clusterId:producer.source.clusterId,routeId:f.routeId,serviceId:f.serviceId,consumerId:null,method:"GET",path:"/same",status:200,latencyKongMs:1,latencyUpstreamMs:null,latencyTotalMs:2,clientIp:"2001:db8::1",requestSize:"9007199254740993",responseSize:"18446744073709551615",retentionDays:7}};}
it("opens a stream only through the existing bearer and confirmed cluster authorization",async()=>{
 await expect(admissions.open("unknown",podUid)).rejects.toThrow();
 const legacy=await f.registered("v1");await expect(admissions.open(legacy.token,podUid)).rejects.toThrow();
 const unconfirmed=await f.registered();await expect(admissions.open(unconfirmed.token,podUid)).rejects.toThrow();
 const stream=await admissions.open(producer.token,podUid);expect(stream.instanceId).toBe(f.instanceId);expect(stream.clusterId).toBe(producer.source.clusterId);
});
it("atomically admits technical descriptors, retries idempotently and never claims persistence",async()=>{
 const s=await admissions.open(producer.token,podUid),batchId=randomUUID(),a=await copy();
 const first=await admissions.prepare(producer.token,s.id,batchId,[a]);const retry=await admissions.prepare(producer.token,s.id,batchId,[a]);expect(retry).toEqual(first);
 expect(first.state).toBe("prepared");const p=await admissions.prefix();expect(p.copiesComplete).toBe(false);expect(p.conflictHistoryComplete).toBe(false);expect(p.coherentSnapshot).toBe(false);expect(p.acceptedThrough).toBe(first.generation);
 const stored=(await f.h.sql.query("select descriptor from analytics_ingestion_batches where id=$1",[batchId])).rows[0]!.descriptor;
 expect(JSON.stringify(stored)).not.toMatch(/2001:db8|same|requestSize|token|Bearer/);
 await expect(admissions.prepare(producer.token,s.id,batchId,[{...a,event:{...a.event,status:500}}])).rejects.toThrow();
});
it("validates normative identity and binding; rejection does not consume a position",async()=>{
 const s=await admissions.open(producer.token,podUid),a=await copy(),before=await admissions.prefix();
 for(const changed of [{...a,event:{...a.event,id:randomUUID()}},{...a,event:{...a.event,environmentId:randomUUID()}},{...a,event:{...a.event,clusterId:randomUUID()}},{...a,podUid:randomUUID()},{...a,event:{...a.event,ts:"2099-01-01T00:00:00.000Z"}},{...a,event:{...a.event,ts:"2000-01-01T00:00:00.000Z"}},{...a,provenance:"workspace-v2"}])
 await expect(admissions.prepare(producer.token,s.id,randomUUID(),[changed])).rejects.toThrow();
 await expect(admissions.prepare(producer.token,s.id,randomUUID(),[a,a])).rejects.toThrow();
 expect((await admissions.prefix()).acceptedThrough).toBe(before.acceptedThrough);
});
it("two replicas serialize admission and identical concurrent retries use one position",async()=>{
 const s=await admissions.open(producer.token,podUid),a=await copy(),id=randomUUID();const replica=new IngestionAdmissions(f.db,f.h.app.get(AgentGatewayService));
 const [one,two]=await Promise.all([admissions.prepare(producer.token,s.id,id,[a]),replica.prepare(producer.token,s.id,id,[a])]);expect(one).toEqual(two);
 const other=await copy();const pair=await Promise.all([admissions.prepare(producer.token,s.id,randomUUID(),[a]),replica.prepare(producer.token,s.id,randomUUID(),[other])]);expect((BigInt(pair[1]!.generation)-BigInt(pair[0]!.generation))**2n).toBe(1n);
});
it("counter and descriptor roll back together if audit insertion fails",async()=>{
 const s=await admissions.open(producer.token,podUid),a=await copy(),before=await admissions.prefix();
 await f.h.sql.query(`create function r18_fail_admission() returns trigger language plpgsql as $$ begin if NEW.action='analytics.ingestion.prepare' then raise exception 'synthetic audit failure'; end if; return NEW; end $$;create trigger r18_fail_admission before insert on audit_events for each row execute function r18_fail_admission()`);
 try{await expect(admissions.prepare(producer.token,s.id,randomUUID(),[a])).rejects.toThrow();}finally{await f.h.sql.query("drop trigger r18_fail_admission on audit_events;drop function r18_fail_admission()");}
 expect((await admissions.prefix()).acceptedThrough).toBe(before.acceptedThrough);
});
it("append-only descriptors survive a new service instance and reject silent updates",async()=>{
 const s=await admissions.open(producer.token,podUid),a=await copy(),id=randomUUID();const p=await admissions.prepare(producer.token,s.id,id,[a]);
 expect((await new IngestionAdmissions(f.db,f.h.app.get(AgentGatewayService)).prefix()).acceptedThrough).toBe(p.generation);
 await expect(f.h.sql.query("update analytics_ingestion_batches set descriptor='[]' where id=$1",[id])).rejects.toThrow();
});
it("confirms a real CH read-back in a separate transaction and replays without reinserting payload",async()=>{
 const s=await admissions.open(producer.token,podUid),a=await copy(),id=randomUUID();
 const receipt=await admissions.persist(producer.token,s.id,id,[a]);expect(receipt).toMatchObject({schemaVersion:1,streamId:s.id,batchId:id,status:"persisted",storedCopies:1,expiredCopies:0});
 const counted=async()=> (await(await reader.query({query:"SELECT toString(count()) AS n FROM requests_v2_copies WHERE ingress_batch_id={id:UUID}",query_params:{id},format:"JSONEachRow"})).json<{n:string}>())[0]!.n;
 expect(await counted()).toBe("1");expect(await admissions.persist(producer.token,s.id,id,[a])).toEqual(receipt);expect(await counted()).toBe("1");
 expect((await admissions.prefix()).copiesComplete).toBe(false);
});
it("a failed receipt audit leaves a durable gap after CH persistence; retry reconciles from real rows",async()=>{
 const s=await admissions.open(producer.token,podUid),a=await copy(),id=randomUUID();
 await f.h.sql.query(`create function r18_fail_receipt() returns trigger language plpgsql as $$ begin if NEW.action='analytics.ingestion.persist' then raise exception 'synthetic receipt failure'; end if; return NEW; end $$;create trigger r18_fail_receipt before insert on audit_events for each row execute function r18_fail_receipt()`);
 try{await expect(admissions.persist(producer.token,s.id,id,[a])).rejects.toThrow();}finally{await f.h.sql.query("drop trigger r18_fail_receipt on audit_events;drop function r18_fail_receipt()");}
 expect((await f.h.sql.query("select count(*)::int as n from analytics_ingestion_receipts where batch_id=$1",[id])).rows[0]!.n).toBe(0);
 expect((await(await reader.query({query:"SELECT toString(count()) AS n FROM requests_v2_copies WHERE ingress_batch_id={id:UUID}",query_params:{id},format:"JSONEachRow"})).json<{n:string}>())[0]!.n).toBe("1");
 expect(await admissions.persist(producer.token,s.id,id,[a])).toMatchObject({status:"persisted",storedCopies:1});
});
it("a CH outage never creates a receipt or consumes a false persistence acknowledgement",async()=>{
 const bad=createClient({url:"http://127.0.0.1:9",request_timeout:250});try{
 const broken=new IngestionAdmissions(f.db,f.h.app.get(AgentGatewayService),new IngestionCopyPersistence(bad,reader));const s=await broken.open(producer.token,podUid),a=await copy(),id=randomUUID();
 await expect(broken.persist(producer.token,s.id,id,[a])).rejects.toThrow("Ingestion persistence is not confirmed");expect((await f.h.sql.query("select count(*)::int as n from analytics_ingestion_receipts where batch_id=$1",[id])).rows[0]!.n).toBe(0);
 }finally{await bad.close();}
});
it("preserves divergent copies but refuses their success receipt",async()=>{
 const s=await admissions.open(producer.token,podUid),a=await copy(),b={...a,copyId:randomUUID(),event:{...a.event,status:500}},id=randomUUID();
 await expect(admissions.persist(producer.token,s.id,id,[a,b])).rejects.toThrow("Ingestion persistence is not confirmed");
 expect((await(await reader.query({query:"SELECT toString(count()) AS n FROM requests_v2_copies WHERE ingress_batch_id={id:UUID}",query_params:{id},format:"JSONEachRow"})).json<{n:string}>())[0]!.n).toBe("2");
 expect((await f.h.sql.query("select count(*)::int as n from analytics_ingestion_receipts where batch_id=$1",[id])).rows[0]!.n).toBe(0);
});
it("tampered stored content cannot manufacture a persistence receipt",async()=>{
 const s=await admissions.open(producer.token,podUid),a=await copy(),id=randomUUID(),prepared=await admissions.prepare(producer.token,s.id,id,[a]);const {id:requestId,...content}=a.event;
 await writer.insert({table:"requests_v2_copies",format:"JSONEachRow",values:[{...encodeRawRequestCopy({id:requestId,content}),ingress_stream_id:s.id,ingress_batch_id:id,ingress_copy_id:a.copyId,ingress_generation:prepared.generation,ingress_wire:"tampered-synthetic-wire"}]});
 await expect(admissions.persist(producer.token,s.id,id,[a])).rejects.toThrow("Ingestion persistence is not confirmed");expect((await f.h.sql.query("select count(*)::int as n from analytics_ingestion_receipts where batch_id=$1",[id])).rows[0]!.n).toBe(0);
});
it("SQL guard rejects a receipt inside the admission's own transaction",async()=>{
 const s=await admissions.open(producer.token,podUid),client=await f.h.sql.connect(),id=randomUUID();
 try{await client.query("begin");await client.query(`insert into analytics_ingestion_batches(id,stream_id,generation,descriptor) select $1,$2,coalesce(max(generation),0)+100,'[{"copyId":"00000000-0000-4000-8000-000000000001","id":"00000000-0000-4000-8000-000000000002","commitment":"synthetic","expiresAt":"2099-01-01T00:00:00.000Z"}]' from analytics_ingestion_batches`,[id,s.id]);await expect(client.query("insert into analytics_ingestion_receipts(batch_id,stored_copies,expired_copies) values($1,1,0)",[id])).rejects.toThrow("receipt requires a committed admission");}finally{await client.query("rollback");client.release();}
});
it("preserves original IPv6 text while confirming the typed IPv6 value",async()=>{
 const s=await admissions.open(producer.token,podUid);
 for(const clientIp of ["2001:0db8:0000:0000:0000:0000:0000:0001","2001:DB8::ABCD","::ffff:192.0.2.1"]){const a=await copy();a.event.clientIp=clientIp;expect(await admissions.persist(producer.token,s.id,randomUUID(),[a])).toMatchObject({status:"persisted"});}
});
it("conflicts in different batches keep the later batch unconfirmed",async()=>{
 const s=await admissions.open(producer.token,podUid),a=await copy(),first=randomUUID(),later=randomUUID();await admissions.persist(producer.token,s.id,first,[a]);
 await expect(admissions.persist(producer.token,s.id,later,[{...a,copyId:randomUUID(),event:{...a.event,status:500}}])).rejects.toThrow("Ingestion persistence is not confirmed");
 expect((await f.h.sql.query("select count(*)::int as n from analytics_ingestion_receipts where batch_id=$1",[later])).rows[0]!.n).toBe(0);
});
it("read-back remains bounded by request identities after unrelated raw traffic exceeds ten thousand rows",async()=>{
 const a=await copy(),{id,...content}=a.event,encoded=encodeRawRequestCopy({id,content}),other=randomUUID();
 await writer.insert({table:"requests_v2_copies",format:"JSONEachRow",values:Array.from({length:10020},()=>({...encoded,id:randomUUID(),environment_id:other}))});
 const s=await admissions.open(producer.token,podUid);expect(await admissions.persist(producer.token,s.id,randomUUID(),[await copy()])).toMatchObject({status:"persisted"});
});
it("does not let another authenticated node claim an existing pod identity",async()=>{
 const created=await f.h.api("POST",`/environments/${f.workspaceId}/clusters`,{name:"synthetic-owner-"+randomUUID()});expect(created.status).toBe(201);const clusterId=created.body.id as string;
 const register=async(nodeId:string)=>{const response=await fetch(`${f.base}/agent/v1/register`,{method:"POST",headers:{authorization:`Bearer ${created.body.registrationToken as string}`,"content-type":"application/json"},body:JSON.stringify({nodeId,hostname:"synthetic-not-authority",kongVersion:"3.9.4",agentVersion:"0.3.0"})});expect(response.status).toBe(200);return (await response.json() as {nodeToken:string}).nodeToken;};
 const firstId="synthetic-owner-1",first=await register(firstId),second=await register("synthetic-owner-2");
 // Explicit synthetic fixture activation; no operational delivery/attestation claim.
 await f.h.sql.query("update clusters set delivery_protocol='v2' where id=$1",[clusterId]);
 const auth=await f.db.transaction(tx=>authorizeClusterDelivery(tx,{actor:{type:"agent",id:firstId},role:"viewer",ip:null},{...producer.source,clusterId,nodeId:firstId,nodeToken:first}));await confirmClusterAssociation(f.db,auth);
 const pod=randomUUID();await admissions.open(first,pod);await expect(admissions.open(second,pod)).rejects.toMatchObject({status:401,response:{detail:"Missing, invalid or revoked ingestion identity"}});expect(await admissions.open(second,randomUUID())).toMatchObject({clusterId});
});
it("SQL cannot override the admission transaction marker",async()=>{
 const s=await admissions.open(producer.token,podUid);await expect(f.h.sql.query(`insert into analytics_ingestion_batches(id,stream_id,generation,descriptor,write_transaction) select $1,$2,coalesce(max(generation),0)+100,'[{}]','synthetic-forged' from analytics_ingestion_batches`,[randomUUID(),s.id])).rejects.toThrow("invalid ingestion admission transaction");
});
it("revocation invalidates an existing producer stream without rewriting prior admissions",async()=>{
 const s=await admissions.open(producer.token,podUid),a=await copy();await f.db.transaction(tx=>revokeClusterAssociation(tx,{actor:{type:"system",id:"synthetic-revocation"},role:"admin",ip:null},producer.source.clusterId,"revoke"));
 await expect(admissions.prepare(producer.token,s.id,randomUUID(),[a])).rejects.toThrow();
});
it("persists conflicts from real readback across batches, restart and raw copy compaction",async()=>{
 producer=await f.registered();const auth=await f.db.transaction(tx=>authorizeClusterDelivery(tx,producer.ctx,producer.source));await confirmClusterAssociation(f.db,auth);
 const {readCopyEvidence}=await import("../../src/analytics/copy-evidence.js");
 const s=await admissions.open(producer.token,podUid),a=await copy(),first=randomUUID();
 await admissions.persist(producer.token,s.id,first,[a]);
 const b={...a,copyId:randomUUID(),event:{...a.event,status:500,routeId:f.otherRouteId}},second=randomUUID();
 await expect(admissions.persist(producer.token,s.id,second,[b])).rejects.toThrow("Ingestion persistence is not confirmed");
 const negative=await readCopyEvidence(f.db,[a.event.id]);expect(negative.items[0]).toMatchObject({id:a.event.id,kind:"conflicting-copies"});
 const admin=integrationInputs(process.env).clickhouse;
 if(!/^gromesh_test_[0-9a-f]{32}$/.test(CLICKHOUSE.database)||admin.url!==CLICKHOUSE.url)throw Error("Unowned maintenance target");
 const maintenance=createClient({url:admin.url,database:CLICKHOUSE.database,username:admin.user,password:admin.password});
 try{
  await maintenance.command({query:"OPTIMIZE TABLE requests_v2_copies FINAL"});
  // Only this synthetic request in the disposable database is removed, emulating loss of raw evidence.
  await maintenance.command({query:"ALTER TABLE requests_v2_copies DELETE WHERE id={id:UUID}",query_params:{id:a.event.id},clickhouse_settings:{mutations_sync:"2"}});
 }finally{await maintenance.close();}
 const restarted=new IngestionAdmissions(f.db,f.h.app.get(AgentGatewayService),new IngestionCopyPersistence(writer,reader));
 expect((await readCopyEvidence(f.db,[a.event.id])).items).toEqual(negative.items);
 // A per-batch retry receipt is historical; it does not erase the global conflict or certify serving.
 expect((await restarted.prefix()).conflictHistoryComplete).toBe(false);
 const rows=(await f.h.sql.query("select count(*)::int n from analytics_ingestion_receipts where batch_id=$1",[second])).rows;expect(rows[0]!.n).toBe(0);
});
it("unverifiable raw copies create an incomplete-comparison tombstone, never a confirmed conflict",async()=>{
 const {readCopyEvidence}=await import("../../src/analytics/copy-evidence.js");
 const s=await admissions.open(producer.token,podUid),a=await copy();const {id,...content}=a.event;
 await writer.insert({table:"requests_v2_copies",format:"JSONEachRow",values:[encodeRawRequestCopy({id,content})]});
 await expect(admissions.persist(producer.token,s.id,randomUUID(),[a])).rejects.toThrow();
 expect((await readCopyEvidence(f.db,[id])).items[0]!.kind).toBe("comparison-unavailable");
});
function barrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
it("fences an old worker after a controlled crash and replica takeover, without a false receipt",async()=>{
 const ready=barrier(),resume=barrier();
 class PausedAfterReadback extends IngestionCopyPersistence{
  override async persist(input:Parameters<IngestionCopyPersistence["persist"]>[0]){const result=await super.persist(input);ready.release();await resume.promise;return result;}
 }
 const slow=new IngestionAdmissions(f.db,f.h.app.get(AgentGatewayService),new PausedAfterReadback(writer,reader));
 const s=await slow.open(producer.token,podUid),a=await copy(),batch=randomUUID();
 const outcome=slow.persist(producer.token,s.id,batch,[a]).then(value=>({value,error:null}),error=>({value:null,error: error as unknown}));
 await ready.promise;
 try{
  // A second replica cannot own an active lease. No sleep is used as synchronization.
  await expect(admissions.persist(producer.token,s.id,batch,[a])).rejects.toThrow();
  expect((await f.h.sql.query("select epoch::text,state from analytics_ingestion_workers where batch_id=$1",[batch])).rows[0]).toEqual({epoch:"1",state:"persisting"});
  // Synthetic clock expiry models a crashed process; only this disposable coordination row is touched.
  await f.h.sql.query("update analytics_ingestion_workers set lease_until=clock_timestamp()-interval '1 second' where batch_id=$1",[batch]);
  expect(await admissions.persist(producer.token,s.id,batch,[a])).toMatchObject({status:"persisted"});
 }finally{resume.release();}
 expect((await outcome).error).toBeTruthy();
 expect((await f.h.sql.query("select epoch::text,state from analytics_ingestion_workers where batch_id=$1",[batch])).rows[0]).toEqual({epoch:"2",state:"verified"});
 expect((await f.h.sql.query("select count(*)::int n from analytics_ingestion_receipts where batch_id=$1",[batch])).rows[0]!.n).toBe(1);
});
it("failed workers release their lease for authenticated retries and keep wire generation unchanged",async()=>{
 const bad=createClient({url:"http://127.0.0.1:9",request_timeout:250});
 try{
  const broken=new IngestionAdmissions(f.db,f.h.app.get(AgentGatewayService),new IngestionCopyPersistence(bad,reader));
  const s=await broken.open(producer.token,podUid),a=await copy(),batch=randomUUID();await expect(broken.persist(producer.token,s.id,batch,[a])).rejects.toThrow();
  expect((await f.h.sql.query("select state from analytics_ingestion_workers where batch_id=$1",[batch])).rows[0]!.state).toBe("failed");
  const prepared=await admissions.prepare(producer.token,s.id,batch,[a]);const receipt=await admissions.persist(producer.token,s.id,batch,[a]);expect(receipt.generation).toBe(prepared.generation);
  expect((await f.h.sql.query("select epoch::text,state from analytics_ingestion_workers where batch_id=$1",[batch])).rows[0]).toEqual({epoch:"2",state:"verified"});
 }finally{await bad.close();}
});
it("authorization revoked after CH readback prevents receipt and cannot be bypassed by a worker lease",async()=>{
 const ready=barrier(),resume=barrier();
 class PausedAfterReadback extends IngestionCopyPersistence{override async persist(input:Parameters<IngestionCopyPersistence["persist"]>[0]){const result=await super.persist(input);ready.release();await resume.promise;return result;}}
 const service=new IngestionAdmissions(f.db,f.h.app.get(AgentGatewayService),new PausedAfterReadback(writer,reader));const s=await service.open(producer.token,podUid),a=await copy(),batch=randomUUID();
 const outcome=service.persist(producer.token,s.id,batch,[a]).then(value=>({value,error:null}),error=>({value:null,error: error as unknown}));await ready.promise;
 try{await f.db.transaction(tx=>revokeClusterAssociation(tx,{actor:{type:"system",id:"synthetic-revocation"},role:"admin",ip:null},producer.source.clusterId,"revoke"));}finally{resume.release();}
 expect((await outcome).error).toBeTruthy();expect((await f.h.sql.query("select count(*)::int n from analytics_ingestion_receipts where batch_id=$1",[batch])).rows[0]!.n).toBe(0);
});
async function forgetRaw(id:string){
 const admin=integrationInputs(process.env).clickhouse;if(!/^gromesh_test_[0-9a-f]{32}$/.test(CLICKHOUSE.database)||admin.url!==CLICKHOUSE.url)throw Error("Unowned maintenance target");
 const maintenance=createClient({url:admin.url,database:CLICKHOUSE.database,username:admin.user,password:admin.password});
 try{await maintenance.command({query:"ALTER TABLE requests_v2_copies DELETE WHERE id={id:UUID}",query_params:{id},clickhouse_settings:{mutations_sync:"2"}});}finally{await maintenance.close();}
}
it("persists missing-comparison history when a prior admitted copy is gone, without equating equal hashes",async()=>{
 producer=await f.registered();const auth=await f.db.transaction(tx=>authorizeClusterDelivery(tx,producer.ctx,producer.source));await confirmClusterAssociation(f.db,auth);
 const {readCopyEvidence}=await import("../../src/analytics/copy-evidence.js"),s=await admissions.open(producer.token,podUid),a=await copy();
 await admissions.persist(producer.token,s.id,randomUUID(),[a]);await forgetRaw(a.event.id);
 const b={...a,copyId:randomUUID()},batch=randomUUID();await expect(admissions.persist(producer.token,s.id,batch,[b])).rejects.toThrow("Ingestion persistence is not confirmed");
 expect((await readCopyEvidence(f.db,[a.event.id])).items[0]!.kind).toBe("comparison-unavailable");expect((await f.h.sql.query("select count(*)::int n from analytics_ingestion_receipts where batch_id=$1",[batch])).rows[0]!.n).toBe(0);
 const restarted=new IngestionAdmissions(f.db,f.h.app.get(AgentGatewayService),new IngestionCopyPersistence(writer,reader));await expect(restarted.persist(producer.token,s.id,batch,[b])).rejects.toThrow();
});
it("detects conflicting earlier admissions after all their raw witnesses have expired or disappeared",async()=>{
 const {readCopyEvidence}=await import("../../src/analytics/copy-evidence.js"),s=await admissions.open(producer.token,podUid),a=await copy();await admissions.persist(producer.token,s.id,randomUUID(),[a]);await forgetRaw(a.event.id);
 const b={...a,copyId:randomUUID(),event:{...a.event,status:503}},batch=randomUUID();await expect(admissions.persist(producer.token,s.id,batch,[b])).rejects.toThrow();
 expect((await readCopyEvidence(f.db,[a.event.id])).items[0]!.kind).toBe("conflicting-copies");expect((await f.h.sql.query("select state from analytics_ingestion_workers where batch_id=$1",[batch])).rows[0]!.state).toBe("failed");
});
it("failed negative-evidence auditing leaves no receipt and releases the still-owned worker for retry",async()=>{
 const s=await admissions.open(producer.token,podUid),a=await copy(),b={...a,copyId:randomUUID(),event:{...a.event,status:503}},batch=randomUUID();
 await f.h.sql.query(`create function fail_reconciliation_audit() returns trigger language plpgsql as $$begin if NEW.action='analytics.copy-evidence.record' then raise exception 'synthetic evidence failure';end if;return NEW;end$$;create trigger fail_reconciliation_audit before insert on audit_events for each row execute function fail_reconciliation_audit()`);
 try{await expect(admissions.persist(producer.token,s.id,batch,[a,b])).rejects.toThrow();}finally{await f.h.sql.query("drop trigger fail_reconciliation_audit on audit_events;drop function fail_reconciliation_audit()");}
 expect((await f.h.sql.query("select state from analytics_ingestion_workers where batch_id=$1",[batch])).rows[0]!.state).toBe("failed");expect((await f.h.sql.query("select count(*)::int n from analytics_ingestion_receipts where batch_id=$1",[batch])).rows[0]!.n).toBe(0);
 await expect(admissions.persist(producer.token,s.id,batch,[a,b])).rejects.toThrow("Ingestion persistence is not confirmed");
 expect((await f.h.sql.query("select count(*)::int n from analytics_copy_evidence where source_batch_id=$1",[batch])).rows[0]!.n).toBe(1);
});
it("measures bounded persistence and engine reads for 100 synthetic unique copies without a serving claim",async()=>{
 const {BoundedCopyReader}=await import("../../src/analytics/bounded-copy-reader.js"),s=await admissions.open(producer.token,podUid),template=await copy();
 const copies=Array.from({length:100},(_,n)=>{const requestId=(n+1).toString(16).padStart(32,"f"),hex=createHash("sha256").update(producer.source.clusterId+"|"+podUid+"|"+requestId).digest("hex").slice(0,32),id=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;return {...template,copyId:randomUUID(),requestId,event:{...template.event,id}};});
 const started=performance.now();expect(await admissions.persist(producer.token,s.id,randomUUID(),copies)).toMatchObject({storedCopies:100});const persistenceMs=performance.now()-started;
 const from=new Date(Date.parse(template.event.ts)-1).toISOString(),to=new Date(Date.parse(template.event.ts)+1).toISOString(),readStarted=performance.now();
 const result=await new BoundedCopyReader(reader).read({instanceId:f.instanceId,from,to,pageSize:200});expect(result.items).toHaveLength(100);expect(result.proof.copiesComplete).toBe(false);
 process.stdout.write("R19_SYNTHETIC_MEASUREMENT "+JSON.stringify({copies:100,persistenceMs,readWallMs:performance.now()-readStarted,engineUsage:result.usage,servingProof:false})+"\n");
});

it("distinguishes a refused real readback from an INSERT ACK and issues no receipt",async()=>{
 const deniedReader=createClient({url:CLICKHOUSE.url,database:CLICKHOUSE.database,username:CLICKHOUSE.user,password:randomUUID()});
 const s=await admissions.open(producer.token,podUid),a=await copy(),id=randomUUID();
 try{
  const isolated=new IngestionAdmissions(f.db,f.h.app.get(AgentGatewayService),new IngestionCopyPersistence(writer,deniedReader));
  const error:unknown=await isolated.persist(producer.token,s.id,id,[a]).catch((error:unknown)=>error);
  expect(error).toMatchObject({stage:'select-request',code:'analytics-not-ready'});
  expect(String(error)+JSON.stringify(error)).not.toMatch(/password|Authorization|2001:db8|requestSize/);
  expect((await f.h.sql.query("select count(*)::int n from analytics_ingestion_receipts where batch_id=$1",[id])).rows[0]!.n).toBe(0);
  const stored=await(await reader.query({query:"SELECT toString(count()) AS n FROM requests_v2_copies WHERE ingress_batch_id={id:UUID}",query_params:{id},format:"JSONEachRow"})).json<{n:string}>();
  expect(stored[0]!.n).toBe('1');
  expect((await admissions.persist(producer.token,s.id,id,[a])).storedCopies).toBe(1);
 }finally{await deniedReader.close();}
});
