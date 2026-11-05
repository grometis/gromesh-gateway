import { createHash, randomUUID } from "node:crypto";
import { beforeAll, afterAll, expect, it } from "vitest";
import { IngestionAdmissions } from "../../src/analytics/ingestion-admissions.js";
import { AgentGatewayService } from "../../src/agent-gateway/agent-gateway.js";
import { authorizeClusterDelivery, confirmClusterAssociation, revokeClusterAssociation } from "../../src/analytics/cluster-history.js";
import { clusterHistoryFixture } from "./cluster-history-fixtures.js";
let f:Awaited<ReturnType<typeof clusterHistoryFixture>>,producer:Awaited<ReturnType<Awaited<ReturnType<typeof clusterHistoryFixture>>["registered"]>>,admissions:IngestionAdmissions;
const podUid="00000000-0000-4000-8000-000000001818";
beforeAll(async()=>{f=await clusterHistoryFixture();producer=await f.registered();const id=await f.db.transaction(tx=>authorizeClusterDelivery(tx,producer.ctx,producer.source));await confirmClusterAssociation(f.db,id);admissions=new IngestionAdmissions(f.db,f.h.app.get(AgentGatewayService));});
afterAll(async()=>{await f?.close();});
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
it("revocation invalidates an existing producer stream without rewriting prior admissions",async()=>{
 const s=await admissions.open(producer.token,podUid),a=await copy();await f.db.transaction(tx=>revokeClusterAssociation(tx,{actor:{type:"system",id:"synthetic-revocation"},role:"admin",ip:null},producer.source.clusterId,"revoke"));
 await expect(admissions.prepare(producer.token,s.id,randomUUID(),[a])).rejects.toThrow();
});
