import { createHash,randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll,beforeAll,it,expect,vi } from "vitest";
import { clusterHistoryFixture } from "./cluster-history-fixtures.js";
import { CLICKHOUSE,CLICKHOUSE_ADMIN } from "./harness.js";
import { IngestionReconciler } from "../../src/analytics/ingestion-reconciler.js";
import { IngestionAdmissions } from "../../src/analytics/ingestion-admissions.js";
import { IngestionCopyPersistence } from "../../src/analytics/ingestion-copy-persistence.js";
import { AgentGatewayService } from "../../src/agent-gateway/agent-gateway.js";
import { authorizeClusterDelivery,confirmClusterAssociation } from "../../src/analytics/cluster-history.js";
const writer=createClient({url:CLICKHOUSE_ADMIN.url,database:CLICKHOUSE_ADMIN.database,username:CLICKHOUSE_ADMIN.user,password:CLICKHOUSE_ADMIN.password});
const reader=createClient({url:CLICKHOUSE.url,database:CLICKHOUSE.database,username:CLICKHOUSE.user,password:CLICKHOUSE.password});
let f:Awaited<ReturnType<typeof clusterHistoryFixture>>,producer:Awaited<ReturnType<Awaited<ReturnType<typeof clusterHistoryFixture>>["registered"]>>,admissions:IngestionAdmissions,streamId:string;
const podUid=randomUUID();
beforeAll(async()=>{f=await clusterHistoryFixture();producer=await f.registered();const id=await f.db.transaction(tx=>authorizeClusterDelivery(tx,producer.ctx,producer.source));await confirmClusterAssociation(f.db,id);admissions=new IngestionAdmissions(f.db,f.h.app.get(AgentGatewayService),new IngestionCopyPersistence(writer,reader));streamId=(await admissions.open(producer.token,podUid)).id;});
afterAll(async()=>{await f?.close();await writer.close();await reader.close();});
async function copy(){const requestId=randomUUID().replaceAll("-","");const hex=createHash("sha256").update(producer.source.clusterId+"|"+podUid+"|"+requestId).digest("hex").slice(0,32);const id=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
 const ts=(await f.h.sql.query<{ts:string}>(`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ts`)).rows[0]!.ts;
 return {schemaVersion:1 as const,copyId:randomUUID(),podUid,requestId,event:{id,ts,environmentId:f.instanceId,clusterId:producer.source.clusterId,routeId:f.routeId,serviceId:f.serviceId,consumerId:null,method:"GET",path:"/same",status:200,latencyKongMs:1,latencyUpstreamMs:null,latencyTotalMs:2,clientIp:"2001:db8::1",requestSize:"9007199254740993",responseSize:"18446744073709551615",retentionDays:7}};
}
it("a reconciliation cannot silently create an admission or advance an unexpected generation",async()=>{
 const a=await copy(),batchId=randomUUID(),before=await admissions.prefix();
 await expect(admissions.persist(producer.token,streamId,batchId,[a],{expectedGeneration:"1"})).rejects.toMatchObject({status:409});
 expect(await admissions.prefix()).toEqual(before);
 const prepared=await admissions.prepare(producer.token,streamId,batchId,[a]);
 await expect(admissions.persist(producer.token,streamId,batchId,[a],{expectedGeneration:(BigInt(prepared.generation)+1n).toString()})).rejects.toMatchObject({status:409});
 expect((await f.h.sql.query("select count(*)::int n from analytics_ingestion_receipts where batch_id=$1",[batchId])).rows[0]!.n).toBe(0);
});
it("recovers PG admission without CH persistence idempotently using original authenticated payload",async()=>{
 const a=await copy(),batchId=randomUUID(),prepared=await admissions.prepare(producer.token,streamId,batchId,[a]);
 const result=await admissions.persist(producer.token,streamId,batchId,[a],{expectedGeneration:prepared.generation});
 expect(result).toMatchObject({status:"persisted",generation:prepared.generation,storedCopies:1});
 expect(await admissions.persist(producer.token,streamId,batchId,[a],{expectedGeneration:prepared.generation})).toEqual(result);
});
it("cancellation after actual CH readback leaves no receipt and can be resumed",async()=>{
 const a=await copy(),batchId=randomUUID(),prepared=await admissions.prepare(producer.token,streamId,batchId,[a]),cancel=new AbortController();
 class StopAfterReadback extends IngestionCopyPersistence{override async persist(input:Parameters<IngestionCopyPersistence["persist"]>[0],signal?:AbortSignal){const result=await super.persist(input,signal);cancel.abort();return result;}}
 const interrupted=new IngestionAdmissions(f.db,f.h.app.get(AgentGatewayService),new StopAfterReadback(writer,reader));
 await expect(interrupted.persist(producer.token,streamId,batchId,[a],{expectedGeneration:prepared.generation,signal:cancel.signal})).rejects.toThrow();
 expect((await f.h.sql.query("select count(*)::int n from analytics_ingestion_receipts where batch_id=$1",[batchId])).rows[0]!.n).toBe(0);
 expect(await admissions.persist(producer.token,streamId,batchId,[a],{expectedGeneration:prepared.generation})).toMatchObject({status:"persisted",storedCopies:1});
});
it("an already cancelled reconciliation does not mutate its admission or start storage I/O",async()=>{
 const a=await copy(),batchId=randomUUID(),prepared=await admissions.prepare(producer.token,streamId,batchId,[a]);
 await expect(admissions.persist(producer.token,streamId,batchId,[a],{expectedGeneration:prepared.generation,signal:AbortSignal.abort()})).rejects.toThrow();
 expect((await f.h.sql.query("select count(*)::int n from analytics_ingestion_workers where batch_id=$1",[batchId])).rows[0]!.n).toBe(0);
});

it("a bounded pass stops on a gap and resumes without duplicating earlier receipts",async()=>{
 const a=await copy(),b=await copy(),one=randomUUID(),two=randomUUID();const first=await admissions.prepare(producer.token,streamId,one,[a]),second=await admissions.prepare(producer.token,streamId,two,[b]);
 const jobs=[{streamId,batchId:one,generation:first.generation,copies:[a]},{streamId,batchId:two,generation:(BigInt(second.generation)+1n).toString(),copies:[b]}];
 const runner=new IngestionReconciler(admissions);const partial=await runner.run(producer.token,jobs);
 expect(partial.completed).toHaveLength(1);expect(partial.pending).toEqual([{batchId:two,generation:jobs[1]!.generation}]);expect(partial.reason).toBe("admission-conflict");
 jobs[1]!.generation=second.generation;const resumed=await runner.run(producer.token,jobs);expect(resumed.completed).toHaveLength(2);expect(resumed.pending).toEqual([]);expect(resumed.reason).toBeNull();
 const before=await admissions.prefix();await expect(runner.run(producer.token,Array(21).fill(jobs[0]))).rejects.toThrow("budget");expect(await admissions.prefix()).toEqual(before);
});
it("unknown bearers cannot reconcile an already admitted batch",async()=>{
 const a=await copy(),batchId=randomUUID(),prepared=await admissions.prepare(producer.token,streamId,batchId,[a]);
 const result=await new IngestionReconciler(admissions).run("unknown",[{streamId,batchId,generation:prepared.generation,copies:[a]}]);
 expect(result.completed).toEqual([]);expect(result.reason).toBe("unauthorized");
 expect((await f.h.sql.query("select count(*)::int n from analytics_ingestion_receipts where batch_id=$1",[batchId])).rows[0]!.n).toBe(0);
});

it("reconciles a partially written batch without acknowledging missing rows",async()=>{
 const a=await copy(),b=await copy(),batchId=randomUUID(),prepared=await admissions.prepare(producer.token,streamId,batchId,[a,b]);
 const original=writer.insert.bind(writer);const spy=vi.spyOn(writer,"insert").mockImplementation(async params=>{if(!Array.isArray(params.values))throw Error("Expected synthetic row batch");return original({...params,values:params.values.slice(0,1)});});
 try{await expect(admissions.persist(producer.token,streamId,batchId,[a,b],{expectedGeneration:prepared.generation})).rejects.toThrow("not confirmed");}finally{spy.mockRestore();}
 expect((await f.h.sql.query("select count(*)::int n from analytics_ingestion_receipts where batch_id=$1",[batchId])).rows[0]!.n).toBe(0);
 expect(await admissions.persist(producer.token,streamId,batchId,[a,b],{expectedGeneration:prepared.generation})).toMatchObject({status:"persisted",storedCopies:2});
});
it("two workers cannot verify the same in-flight attempt concurrently",async()=>{
 let reached!:()=>void,resume!:()=>void;const ready=new Promise<void>(resolve=>{reached=resolve;}),release=new Promise<void>(resolve=>{resume=resolve;});
 class Paused extends IngestionCopyPersistence{override async persist(input:Parameters<IngestionCopyPersistence["persist"]>[0],signal?:AbortSignal){const result=await super.persist(input,signal);reached();await release;return result;}}
 const first=new IngestionAdmissions(f.db,f.h.app.get(AgentGatewayService),new Paused(writer,reader));
 const a=await copy(),batchId=randomUUID(),prepared=await admissions.prepare(producer.token,streamId,batchId,[a]);
 const running=first.persist(producer.token,streamId,batchId,[a],{expectedGeneration:prepared.generation});await ready;
 try{await expect(admissions.persist(producer.token,streamId,batchId,[a],{expectedGeneration:prepared.generation})).rejects.toMatchObject({status:409});}finally{resume();}
 expect(await running).toMatchObject({status:"persisted",storedCopies:1});
});
