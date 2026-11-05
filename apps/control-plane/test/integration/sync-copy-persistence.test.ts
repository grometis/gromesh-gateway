import {createHash,randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from "vitest";
import {physicalFenceFixture} from "./physical-fence-fixture.js";
import {clusterHistoryFixture} from "./cluster-history-fixtures.js";
import {authorizeClusterDelivery,confirmClusterAssociation} from "../../src/analytics/cluster-history.js";
import {AgentGatewayService} from "../../src/agent-gateway/agent-gateway.js";
import {IngestionAdmissions} from "../../src/analytics/ingestion-admissions.js";
import {IngestionCopyPersistence} from "../../src/analytics/ingestion-copy-persistence.js";
import {BoundedCopyQueries} from "../../src/analytics/bounded-copy-queries.js";
import {SyncIngestionCopyPersistence} from "../../src/analytics/sync-copy-persistence.js";
let f:Awaited<ReturnType<typeof clusterHistoryFixture>>,producer:Awaited<ReturnType<Awaited<ReturnType<typeof clusterHistoryFixture>>['registered']>>,store:Awaited<ReturnType<typeof physicalFenceFixture>>,streamId:string;
const podUid=randomUUID();
beforeAll(async()=>{f=await clusterHistoryFixture();producer=await f.registered();const id=await f.db.transaction(tx=>authorizeClusterDelivery(tx,producer.ctx,producer.source));await confirmClusterAssociation(f.db,id);streamId=(await new IngestionAdmissions(f.db,f.h.app.get(AgentGatewayService)).open(producer.token,podUid)).id;});
beforeEach(async()=>{store=await physicalFenceFixture({sync:true});});
afterEach(()=>store?.close());afterAll(()=>f?.close());
const service=(persistence:IngestionCopyPersistence=new SyncIngestionCopyPersistence(store.writer,store.reader))=>new IngestionAdmissions(f.db,f.h.app.get(AgentGatewayService),persistence);
async function upgrade(target=store){const sql=readFileSync(new URL("../../../../deploy/observability/clickhouse/005-sync-copy-persistence.sql",import.meta.url),"utf8").replaceAll("gromesh.requests_v2_copies","requests_v2_copies");for(const query of sql.split(';').map(s=>s.trim()).filter(Boolean))await target.operator.command({query});}
async function copy(){const requestId=randomUUID().replaceAll('-',''),hex=createHash('sha256').update(producer.source.clusterId+'|'+podUid+'|'+requestId).digest('hex').slice(0,32),id=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
 const ts=(await f.h.sql.query(`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ts`)).rows[0]!.ts as string;
 return {schemaVersion:1 as const,copyId:randomUUID(),podUid,requestId,event:{id,ts,environmentId:f.instanceId,clusterId:producer.source.clusterId,routeId:f.routeId,serviceId:f.serviceId,consumerId:null,method:'GET',path:'/same',status:200,latencyKongMs:1,latencyUpstreamMs:null,latencyTotalMs:2,clientIp:'2001:db8::1',requestSize:'9007199254740993',responseSize:'18446744073709551615',retentionDays:7}};
}
const receiptCount=async(batchId:string)=>(await f.h.sql.query("select count(*)::int n from analytics_ingestion_receipts where batch_id=$1",[batchId])).rows[0]!.n as number;
it("refuses old storage policy before INSERT and keeps the default writer compatible",async()=>{
 const a=await copy(),batchId=randomUUID();await expect(service().persist(producer.token,streamId,batchId,[a])).rejects.toThrow("not confirmed");expect(await receiptCount(batchId)).toBe(0);
 const empty=await store.reader.query({query:"SELECT toString(count()) n FROM requests_v2_copies",format:'JSONEachRow'});expect(await empty.json()).toEqual([{n:'0'}]);
 expect(await service(new IngestionCopyPersistence(store.writer,store.reader)).persist(producer.token,streamId,batchId,[a])).toMatchObject({status:'persisted'});
 const before=await store.reader.query({query:"SELECT toString(request_size) size FROM requests_v2_copies",format:'JSONEachRow'});expect(await before.json()).toEqual([{size:'9007199254740993'}]);
 await upgrade();await upgrade();const after=await store.reader.query({query:"SELECT toString(request_size) size FROM requests_v2_copies",format:'JSONEachRow'});expect(await after.json()).toEqual([{size:'9007199254740993'}]);
});
it("commits a resource-bound witness with the real receipt and keeps serving conservative",async()=>{
 await upgrade();const a=await copy(),batchId=randomUUID();
 // Query tracing is enabled ONLY for this synthetic INSERT so the harness can inspect real fsync counters.
 const original=store.writer.insert.bind(store.writer),traceSpy=vi.spyOn(store.writer,'insert').mockImplementation(params=>original({...params,clickhouse_settings:{...params.clickhouse_settings,log_queries:1}}));
 try{expect(await service().persist(producer.token,streamId,batchId,[a])).toMatchObject({status:'persisted'});}finally{traceSpy.mockRestore();}
 const row=(await f.h.sql.query("select after from audit_events where action='analytics.ingestion.persist' and entity_id=$1",[batchId])).rows[0]!.after as {storageWitness:Record<string,unknown>};
 const actual=await store.reader.query({query:"SELECT version() serverVersion,toString(serverUUID()) serverId,toString(uuid) tableId FROM system.tables WHERE database=currentDatabase() AND name='requests_v2_copies'",format:'JSONEachRow'});
 expect(row.storageWitness).toMatchObject({kind:'observed-sync-policy-readback-v1',...(await actual.json<Record<string,unknown>>())[0]});expect(row.storageWitness.insertQueryId).toMatch(/^[0-9a-f-]{36}$/);
 expect(JSON.stringify(row.storageWitness)).not.toMatch(/same|2001:db8|Bearer|token|clientIp|session/i);
 expect((await service().prefix()).copiesComplete).toBe(false);
 await store.operator.command({query:'SYSTEM FLUSH LOGS'});
 const events=await store.operator.query({query:"SELECT ProfileEvents['FileSync'] fsync,ProfileEvents['DirectorySync'] directorySync FROM system.query_log WHERE type='QueryFinish' AND query_id={id:String}",query_params:{id:row.storageWitness.insertQueryId},format:'JSONEachRow'});
 const trace=(await events.json<{fsync:string;directorySync:string}>())[0];expect(trace).toBeDefined();expect(BigInt(trace!.fsync)).toBeGreaterThan(0n);expect(BigInt(trace!.directorySync)).toBeGreaterThan(0n);
});
it("refuses mismatched physical resources before writing",async()=>{
 await upgrade();const other=await physicalFenceFixture({sync:true});try{await upgrade(other);const a=await copy(),batchId=randomUUID();
 await expect(service(new SyncIngestionCopyPersistence(store.writer,other.reader)).persist(producer.token,streamId,batchId,[a])).rejects.toThrow("not confirmed");expect(await receiptCount(batchId)).toBe(0);
 }finally{await other.close();}
});
it("does not certify a storage-policy change after an acknowledged INSERT",async()=>{
 await upgrade();const a=await copy(),batchId=randomUUID(),original=store.writer.insert.bind(store.writer);
 const spy=vi.spyOn(store.writer,'insert').mockImplementation(async params=>{const result=await original(params);await store.operator.command({query:'ALTER TABLE requests_v2_copies MODIFY SETTING fsync_after_insert=0'});return result;});
 try{await expect(service().persist(producer.token,streamId,batchId,[a])).rejects.toThrow("not confirmed");}finally{spy.mockRestore();}expect(await receiptCount(batchId)).toBe(0);
});
it("a lost writer session cannot emit a persistence receipt",async()=>{
 await upgrade();const a=await copy(),batchId=randomUUID(),original=store.writer.insert.bind(store.writer);const spy=vi.spyOn(store.writer,'insert').mockImplementation(params=>original({...params,session_id:randomUUID()}));
 try{await expect(service().persist(producer.token,streamId,batchId,[a])).rejects.toThrow("not confirmed");}finally{spy.mockRestore();}expect(await receiptCount(batchId)).toBe(0);
});
it("rolls back witness and receipt together when audit persistence fails",async()=>{
 await upgrade();const a=await copy(),batchId=randomUUID();
 await f.h.sql.query(`create function r20_sync_audit_failure() returns trigger language plpgsql as $$ begin if NEW.action='analytics.ingestion.persist' then raise exception 'synthetic sync audit failure'; end if; return NEW; end $$;create trigger r20_sync_audit_failure before insert on audit_events for each row execute function r20_sync_audit_failure()`);
 try{await expect(service().persist(producer.token,streamId,batchId,[a])).rejects.toThrow();}finally{await f.h.sql.query('drop trigger r20_sync_audit_failure on audit_events;drop function r20_sync_audit_failure()');}
 expect(await receiptCount(batchId)).toBe(0);expect((await f.h.sql.query("select count(*)::int n from audit_events where action='analytics.ingestion.persist' and entity_id=$1",[batchId])).rows[0]!.n).toBe(0);
 expect(await service().persist(producer.token,streamId,batchId,[a])).toMatchObject({status:'persisted'});
});

it("accounts the real engine reads across both authenticated sessions in one budget",async()=>{
 const reader=new BoundedCopyQueries(store.reader,{maxReadRows:1},undefined,`r20-budget-reader-${randomUUID()}`),writer=reader.withSession(store.writer,`r20-budget-writer-${randomUUID()}`);
 expect(await reader.query('SELECT number FROM numbers(1)',{},1)).toHaveLength(1);expect(reader.usage.readRows).toBe(1);
 await expect(writer.query('SELECT number FROM numbers(1)',{},1)).rejects.toMatchObject({code:'analytics-budget-exceeded'});expect(writer.usage).toBe(reader.usage);
});
it('accepts expiry-only retry disposition without inventing an INSERT witness',async()=>{
 await upgrade();const a=await copy();a.event.retentionDays=1;const batchId=randomUUID(),prepared=await service().prepare(producer.token,streamId,batchId,[a]);
 // Explicit synthetic observation-clock advance exercises the adapter; no real-time expiry or PG receipt is fabricated.
 const asOf=new Date(Date.parse(a.event.ts)+2*86400000).toISOString();
 const disposed=await new SyncIngestionCopyPersistence(store.writer,store.reader).persist({streamId,batchId,generation:prepared.generation,copies:[a],asOf});
 expect(disposed).toMatchObject({storedCopies:0,expiredCopies:1});expect(disposed).not.toHaveProperty('storageWitness');expect(disposed).not.toHaveProperty('insertQueryId');
 const rows=await store.reader.query({query:'SELECT toString(count()) n FROM requests_v2_copies',format:'JSONEachRow'});expect(await rows.json()).toEqual([{n:'0'}]);expect(await receiptCount(batchId)).toBe(0);
});
