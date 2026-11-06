import{createHash,randomUUID}from"node:crypto";
import{readFileSync}from"node:fs";
import{afterEach,beforeEach,expect,it,vi}from"vitest";
import{physicalFenceFixture}from"./physical-fence-fixture.js";
import{PhysicalCopyFence}from"../../src/analytics/physical-copy-fence.js";
import{SyncIngestionCopyPersistence}from"../../src/analytics/sync-copy-persistence.js";
let store:Awaited<ReturnType<typeof physicalFenceFixture>>;
beforeEach(async()=>{store=await physicalFenceFixture({sync:true});const sql=readFileSync(new URL("../../../../deploy/observability/clickhouse/005-sync-copy-persistence.sql",import.meta.url),"utf8").replaceAll("gromesh.requests_v2_copies","requests_v2_copies");for(const query of sql.split(';').map(s=>s.trim()).filter(Boolean))await store.operator.command({query});});
afterEach(()=>store?.close());
// Synthetic component-level rows, not producer authentication or operational serving evidence.
function input(){const clusterId=randomUUID(),podUid=randomUUID(),requestId=randomUUID().replaceAll('-',''),hex=createHash('sha256').update(clusterId+'|'+podUid+'|'+requestId).digest('hex').slice(0,32),id=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
return{streamId:randomUUID(),batchId:randomUUID(),generation:'1',asOf:'2099-11-01T12:00:00.000Z',copies:[{schemaVersion:1 as const,copyId:randomUUID(),podUid,requestId,event:{id,ts:'2099-11-01T12:00:00.000Z',environmentId:randomUUID(),clusterId,serviceId:null,routeId:randomUUID(),consumerId:null,method:'GET',path:'/synthetic-only',status:200,latencyKongMs:1,latencyUpstreamMs:null,latencyTotalMs:2,clientIp:'2001:db8::1',requestSize:'9007199254740993',responseSize:'18446744073709551615',retentionDays:7}}]};}
for(const [name,sql]of Object.entries({extraColumn:'ADD COLUMN hidden_state UInt8 DEFAULT 0',aliasColumn:'ADD COLUMN hidden_state UInt16 ALIAS status',typeChange:'MODIFY COLUMN status UInt32',defaultChange:'MODIFY COLUMN status UInt16 DEFAULT 200',ingressType:'MODIFY COLUMN ingress_generation Nullable(UInt128)',pathTtl:'MODIFY COLUMN path String TTL ts + INTERVAL 1 DAY',wireTtl:'MODIFY COLUMN ingress_wire Nullable(String) TTL ts + INTERVAL 1 DAY',codecChange:'MODIFY COLUMN request_size UInt64 CODEC(Delta, ZSTD)'}))it(`refuses a stable unsupported logical schema: ${name}`,async()=>{
 await store.operator.command({query:'ALTER TABLE requests_v2_copies '+sql});
 await expect(new PhysicalCopyFence(store.reader).observe([])).rejects.toMatchObject({code:'analytics-not-ready'});
 const spy=vi.spyOn(store.writer,'insert');try{await expect(new SyncIngestionCopyPersistence(store.writer,store.reader).persist(input())).rejects.toThrow();expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}
});
it('does not issue a witness when the logical schema changes after the actual INSERT ACK',async()=>{
 const original=store.writer.insert.bind(store.writer),spy=vi.spyOn(store.writer,'insert').mockImplementation(async p=>{const result=await original(p);await store.operator.command({query:'ALTER TABLE requests_v2_copies ADD COLUMN hidden_state UInt8 DEFAULT 0'});return result;});
 try{await expect(new SyncIngestionCopyPersistence(store.writer,store.reader).persist(input())).rejects.toThrow();}finally{spy.mockRestore();}
});
it('accepts the exact v2 schema, preserves UInt64, and ignores changes to the separate legacy table',async()=>{
 await store.operator.command({query:'ALTER TABLE requests ADD COLUMN legacy_only UInt8 DEFAULT 0'});
 const value=input(),result=await new SyncIngestionCopyPersistence(store.writer,store.reader).persist(value);expect(result.storageWitness?.insertQueryId).toBeDefined();
 const observation=await new PhysicalCopyFence(store.reader).observe([value.copies[0]!.event.id]);expect(observation.rows).toHaveLength(1);expect(observation.rows[0]!.request_size).toBe('9007199254740993');expect(Object.values(observation.proof).every(v=>v===false)).toBe(true);
});
it('includes real schema bytes in the same aggregate query budget',async()=>{
 await expect(new PhysicalCopyFence(store.reader).observe([],{maxDecodedBytes:4000})).rejects.toMatchObject({code:'analytics-budget-exceeded'});
});

it('does not certify a column TTL introduced after the actual INSERT ACK',async()=>{
 const original=store.writer.insert.bind(store.writer),spy=vi.spyOn(store.writer,'insert').mockImplementation(async p=>{const result=await original(p);await store.operator.command({query:'ALTER TABLE requests_v2_copies MODIFY COLUMN ingress_wire Nullable(String) TTL ts + INTERVAL 1 DAY'});return result;});
 try{await expect(new SyncIngestionCopyPersistence(store.writer,store.reader).persist(input())).rejects.toThrow();}finally{spy.mockRestore();}
});
