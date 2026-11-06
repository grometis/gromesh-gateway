import { createHash,randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import { afterAll,afterEach,beforeAll,beforeEach,expect,it } from "vitest";
import { RawRequestCopyStore } from "../../src/analytics/request-copy-store.js";
import { IngestionAdmissions } from "../../src/analytics/ingestion-admissions.js";
import { IngestionCopyPersistence } from "../../src/analytics/ingestion-copy-persistence.js";
import { PersistedPrefixObserver } from "../../src/analytics/persisted-prefix-observer.js";
import { withIngestionReadFence } from "../../src/analytics/ingestion-read-snapshot.js";
import { PhysicalCopyFence } from "../../src/analytics/physical-copy-fence.js";
import { AgentGatewayService } from "../../src/agent-gateway/agent-gateway.js";
import { authorizeClusterDelivery,confirmClusterAssociation } from "../../src/analytics/cluster-history.js";
import { clusterHistoryFixture } from "./cluster-history-fixtures.js";
import { physicalFenceFixture } from "./physical-fence-fixture.js";
let fixture:Awaited<ReturnType<typeof physicalFenceFixture>>,writer:ClickHouseClient,reader:ClickHouseClient;
let f:Awaited<ReturnType<typeof clusterHistoryFixture>>,producer:Awaited<ReturnType<Awaited<ReturnType<typeof clusterHistoryFixture>>["registered"]>>,admissions:IngestionAdmissions;
const podUid=randomUUID();
beforeAll(async()=>{fixture=await physicalFenceFixture();writer=fixture.writer;reader=fixture.reader;});
beforeEach(async()=>{f=await clusterHistoryFixture();producer=await f.registered();const id=await f.db.transaction(tx=>authorizeClusterDelivery(tx,producer.ctx,producer.source));await confirmClusterAssociation(f.db,id);admissions=new IngestionAdmissions(f.db,f.h.app.get(AgentGatewayService),new IngestionCopyPersistence(writer,reader));});
afterEach(()=>f?.close());
afterAll(()=>fixture?.close());
async function copy(){const requestId=randomUUID().replaceAll("-","");const hex=createHash("sha256").update(producer.source.clusterId+"|"+podUid+"|"+requestId).digest("hex").slice(0,32);const id=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
 const ts=(await f.h.sql.query<{ts:string}>(`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ts`)).rows[0]!.ts;
 return {schemaVersion:1 as const,copyId:randomUUID(),podUid,requestId,event:{id,ts,environmentId:f.instanceId,clusterId:producer.source.clusterId,routeId:f.routeId,serviceId:f.serviceId,consumerId:null,method:"GET",path:"/same",status:200,latencyKongMs:1,latencyUpstreamMs:null,latencyTotalMs:2,clientIp:"2001:db8::1",requestSize:"9007199254740993",responseSize:"18446744073709551615",retentionDays:7}};
}
it("performs network observation without keeping a PostgreSQL transaction open",async()=>{
 await withIngestionReadFence(f.h.sql,async()=>"plan",async()=>{
  const row=(await f.h.sql.query("select state,xact_start from pg_stat_activity where application_name like 'gromesh-analytics-read:%' and datname=current_database()" )).rows;
  expect(row).toHaveLength(1);expect(row[0]).toMatchObject({state:"idle",xact_start:null});return "actual observation";
 },async(_db,plan,observed)=>{expect(plan).toBe("plan");expect(observed).toBe("actual observation");});
});
it("observes every admitted copy through the contiguous prefix using real PG receipts and CH rows",async()=>{
 const stream=await admissions.open(producer.token,podUid);
 const a=await copy(),b=await copy();await admissions.persist(producer.token,stream.id,randomUUID(),[a]);const last=await admissions.persist(producer.token,stream.id,randomUUID(),[b]);
 const result=await new PersistedPrefixObserver(f.h.sql,new PhysicalCopyFence(reader)).observe();
 expect(result.observedThrough).toBe(last.generation);expect(result.copiesCompared).toBe(2);expect(result.physical.parts.length).toBeGreaterThan(0);
 expect(result.proof).toEqual({copiesComplete:false,conflictHistoryComplete:false,coherentSnapshot:false,deliveryFromKongComplete:false});
});
it("does not treat an old receipt as evidence that a missing copy still exists",async()=>{
 const stream=await admissions.open(producer.token,podUid),a=await copy(),batchId=randomUUID();await admissions.persist(producer.token,stream.id,batchId,[a]);
 await fixture.operator.command({query:"ALTER TABLE requests_v2_copies DELETE WHERE ingress_batch_id={batchId:UUID} SETTINGS mutations_sync=2",query_params:{batchId}});
 await expect(new PersistedPrefixObserver(f.h.sql,new PhysicalCopyFence(reader)).observe()).rejects.toMatchObject({code:"analytics-not-ready"});
});
it("rejects a global divergent copy even when its instance and status differ",async()=>{
 const stream=await admissions.open(producer.token,podUid),a=await copy();await admissions.persist(producer.token,stream.id,randomUUID(),[a]);const {id,...content}=a.event;
 await new RawRequestCopyStore(writer).append([{id,content:{...content,environmentId:randomUUID(),status:500}}]);
 await expect(new PersistedPrefixObserver(f.h.sql,new PhysicalCopyFence(reader)).observe()).rejects.toMatchObject({code:"analytics-not-ready"});
});
it("refuses a failed worker despite an earlier individual-batch receipt",async()=>{
 const stream=await admissions.open(producer.token,podUid),batchId=randomUUID();await admissions.persist(producer.token,stream.id,batchId,[await copy()]);
 await f.h.sql.query("update analytics_ingestion_workers set state='failed',epoch=epoch+1 where batch_id=$1",[batchId]);
 await expect(new PersistedPrefixObserver(f.h.sql,new PhysicalCopyFence(reader)).observe()).rejects.toMatchObject({code:"analytics-not-ready"});
});
it("a later successful receipt cannot leap over an intermediate missing batch",async()=>{
 const stream=await admissions.open(producer.token,podUid),missing=await copy();await admissions.prepare(producer.token,stream.id,randomUUID(),[missing]);await admissions.persist(producer.token,stream.id,randomUUID(),[await copy()]);
 await expect(new PersistedPrefixObserver(f.h.sql,new PhysicalCopyFence(reader)).observe()).rejects.toMatchObject({code:"analytics-not-ready"});
});
