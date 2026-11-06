import { cpSync,mkdtempSync,readFileSync,writeFileSync,appendFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { integrationDatabaseName,createIntegrationDatabase,dropIntegrationDatabase } from "./databases.js";
import { MIGRATIONS_DIR,runMigrations } from "../../src/db/migrate.js";
import { createHash,randomUUID } from "node:crypto";
import { beforeAll,afterAll,it,expect } from "vitest";
import { sql } from "drizzle-orm";
import { clusterHistoryFixture } from "./cluster-history-fixtures.js";
import { authorizeClusterDelivery,confirmClusterAssociation } from "../../src/analytics/cluster-history.js";
import { IngestionAdmissions } from "../../src/analytics/ingestion-admissions.js";
import { AgentGatewayService } from "../../src/agent-gateway/agent-gateway.js";
import { audit } from "../../src/audit/audit.js";
import { pruneAdmissionHistory } from "../../src/analytics/admission-retention.js";
import { readCopyEvidenceSnapshot } from "../../src/analytics/copy-evidence.js";
import { readAdmissionPrefix } from "../../src/analytics/ingestion-read-snapshot.js";
let f:Awaited<ReturnType<typeof clusterHistoryFixture>>,producer:Awaited<ReturnType<Awaited<ReturnType<typeof clusterHistoryFixture>>["registered"]>>,streamId:string;
beforeAll(async()=>{f=await clusterHistoryFixture();producer=await f.registered();const id=await f.db.transaction(tx=>authorizeClusterDelivery(tx,producer.ctx,producer.source));await confirmClusterAssociation(f.db,id);streamId=(await new IngestionAdmissions(f.db,f.h.app.get(AgentGatewayService)).open(producer.token,randomUUID())).id;});
afterAll(()=>f?.close());
/** Artificial old technical descriptors exercise GC only; not historical producer/ingestion proof. */
async function seed(options:{age?:number;expiry?:number;worker?:boolean;negative?:boolean;receipt?:boolean}={}){
 const id=randomUUID(),requestId=randomUUID();
 await f.db.transaction(async tx=>{
  await tx.execute(sql`select pg_advisory_xact_lock(1818,1801)`);
  const generation=(await tx.execute<{position:string}>(sql`insert into analytics_ingestion_counter(singleton,position) values(true,1) on conflict(singleton) do update set position=analytics_ingestion_counter.position+1 returning position::text`)).rows[0]!.position;
  const expires=(await tx.execute<{ts:string}>(sql`select to_char((clock_timestamp()+${options.expiry??-1}*interval '1 day') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ts`)).rows[0]!.ts;
  const descriptor=JSON.stringify([{copyId:randomUUID(),id:requestId,commitment:"a".repeat(64),expiresAt:expires}]);
  await tx.execute(sql`insert into analytics_ingestion_batches(id,stream_id,generation,descriptor,recorded_at) values(${id},${streamId},${generation},${descriptor}::jsonb,clock_timestamp()-${options.age??8}*interval '1 day')`);
  if(options.worker)await tx.execute(sql`insert into analytics_ingestion_workers(batch_id,epoch,token,state,lease_until) values(${id},1,${randomUUID()},'persisting',clock_timestamp()+interval '30 seconds')`);
  if(options.negative)await tx.execute(sql`insert into analytics_copy_evidence(request_id,source_batch_id,generation,kind,left_hash,right_hash,expires_at) values(${requestId},${id},${generation},'comparison-unavailable',${"a".repeat(64)},'',clock_timestamp()+interval '1 day')`);
  await audit(tx,producer.ctx,{action:"synthetic.admission-history",entityType:"ingestion-batch",entityId:id});
 });
 if(options.receipt)await f.db.transaction(async tx=>{
  await tx.execute(sql`insert into analytics_ingestion_receipts(batch_id,stored_copies,expired_copies) values(${id},0,1)`);
  await tx.execute(sql`insert into analytics_ingestion_workers(batch_id,epoch,token,state,lease_until) values(${id},1,${randomUUID()},'verified',clock_timestamp())`);
  await audit(tx,producer.ctx,{action:"synthetic.expired-receipt",entityType:"ingestion-batch",entityId:id});
 });return id;
}
const exists=async(id:string)=>(await f.h.sql.query("select 1 from analytics_ingestion_batches where id=$1",[id])).rowCount===1;
it("evaluates exact expiry and 1–7 day payload horizons against a deterministic SQL clock",async()=>{
 for(let days=1;days<=7;days++){
  const expires=`2026-10-${String(20+days).padStart(2,"0")}T00:00:00.000Z`;
  const descriptor=JSON.stringify([{expiresAt:expires}]);
  const row=(await f.h.sql.query("select analytics_ingestion_history_expired($1::jsonb,'2026-10-20T00:00:00Z','2026-10-27T00:00:00Z') exact,analytics_ingestion_history_expired($1::jsonb,'2026-10-20T00:00:00Z','2026-10-26T23:59:59.999999Z') early",[descriptor])).rows[0];
  expect(row).toEqual({exact:true,early:false});
 }
});
it("limits deletion, preserves counter and marks irreversible historical loss in the same commit",async()=>{
 const old=await seed(),second=await seed();const counter=(await f.h.sql.query("select position::text from analytics_ingestion_counter")).rows[0]!.position;
 expect(await pruneAdmissionHistory(f.db,producer.ctx,1)).toMatchObject({removed:1});expect([await exists(old),await exists(second)].filter(Boolean)).toHaveLength(1);
 expect(await pruneAdmissionHistory(f.db,producer.ctx,1)).toMatchObject({removed:1});expect(await pruneAdmissionHistory(f.db,producer.ctx,1)).toMatchObject({removed:0});
 expect((await f.h.sql.query("select position::text from analytics_ingestion_counter")).rows[0]!.position).toBe(counter);
 const prefix=await f.db.transaction(tx=>readAdmissionPrefix(tx),{isolationLevel:"repeatable read",accessMode:"read only"});expect(prefix.admissionHistoryPruned).toBe(true);expect(prefix.receiptPrefixComplete).toBe(false);
 const negative=await f.db.transaction(tx=>readCopyEvidenceSnapshot(tx,[]),{isolationLevel:"repeatable read",accessMode:"read only"});expect(negative.historyPruned).toBe(true);
});
it("preserves recent metadata, partially expired batches, active workers and still-required negatives",async()=>{
 const ids=await Promise.all([seed({age:6}),seed({expiry:1}),seed({worker:true}),seed({negative:true})]);
 expect(await pruneAdmissionHistory(f.db,producer.ctx,100)).toMatchObject({removed:0});for(const id of ids)expect(await exists(id)).toBe(true);
});
it("two replicas prune once under the ingestion lock",async()=>{
 const id=await seed();const result=await Promise.all([pruneAdmissionHistory(f.db,producer.ctx,1),pruneAdmissionHistory(f.db,producer.ctx,1)]);expect(result.reduce((sum,r)=>sum+r.removed,0)).toBe(1);expect(await exists(id)).toBe(false);
});
it("rolls back deletion and coverage when the transactional audit fails",async()=>{
 const id=await seed();const before=(await f.h.sql.query("select pruned_through::text from analytics_ingestion_prune_coverage")).rows[0]!.pruned_through;
 await f.h.sql.query(`create function r20_gc_audit_failure() returns trigger language plpgsql as $$ begin if NEW.action='analytics.ingestion.prune' then raise exception 'synthetic audit failure'; end if; return NEW; end $$;create trigger r20_gc_audit_failure before insert on audit_events for each row execute function r20_gc_audit_failure()`);
 try{await expect(pruneAdmissionHistory(f.db,producer.ctx,1)).rejects.toMatchObject({cause:{message:"synthetic audit failure"}});}finally{await f.h.sql.query("drop trigger r20_gc_audit_failure on audit_events;drop function r20_gc_audit_failure()");}
 expect(await exists(id)).toBe(true);expect((await f.h.sql.query("select pruned_through::text from analytics_ingestion_prune_coverage")).rows[0]!.pruned_through).toBe(before);
 expect(await pruneAdmissionHistory(f.db,producer.ctx,1)).toMatchObject({removed:1});
});
it("removes only expired receipts/workers together and rolls back a failure halfway through deletion",async()=>{
 const id=await seed({receipt:true});
 await f.h.sql.query(`create function r20_gc_delete_failure() returns trigger language plpgsql as $$ begin raise exception 'synthetic delete failure'; end $$;create trigger r20_gc_delete_failure before delete on analytics_ingestion_batches for each row execute function r20_gc_delete_failure()`);
 try{await expect(pruneAdmissionHistory(f.db,producer.ctx,1)).rejects.toMatchObject({cause:{message:"synthetic delete failure"}});}finally{await f.h.sql.query("drop trigger r20_gc_delete_failure on analytics_ingestion_batches;drop function r20_gc_delete_failure()");}
 expect(await exists(id)).toBe(true);
 for(const table of ["analytics_ingestion_receipts","analytics_ingestion_workers"])expect((await f.h.sql.query(`select count(*)::int n from ${table} where batch_id=$1`,[id])).rows[0]!.n).toBe(1);
 expect(await pruneAdmissionHistory(f.db,producer.ctx,1)).toMatchObject({removed:1});
 for(const table of ["analytics_ingestion_receipts","analytics_ingestion_workers"])expect((await f.h.sql.query(`select count(*)::int n from ${table} where batch_id=$1`,[id])).rows[0]!.n).toBe(0);
});
it("rejects unguarded deletion, coverage reset and invalid limits",async()=>{
 const id=await seed({age:0});await expect(f.h.sql.query("delete from analytics_ingestion_batches where id=$1",[id])).rejects.toThrow();
 await expect(f.h.sql.query("delete from analytics_ingestion_prune_coverage")).rejects.toThrow();
 await expect(f.h.sql.query("update analytics_ingestion_prune_coverage set pruned_through=0")).rejects.toThrow();
 for(const limit of [0,1001,1.5])await expect(pruneAdmissionHistory(f.db,producer.ctx,limit)).rejects.toThrow();
});

it("upgrades schema 0034 without rewriting data and rolls back a failed 0035 migration",async()=>{
 const name=integrationDatabaseName("r20upgrade"),url=await createIntegrationDatabase(name),folder=mkdtempSync(join(tmpdir(),"r20-migration-"));let client:pg.Client|undefined;
 try{
  cpSync(MIGRATIONS_DIR,folder,{recursive:true});const journal=JSON.parse(readFileSync(join(folder,"meta/_journal.json"),"utf8")) as {entries:{idx:number;tag:string}[]};
  writeFileSync(join(folder,"meta/_journal.json"),JSON.stringify({...journal,entries:journal.entries.filter(e=>e.idx<=34)}));
  await runMigrations(url,folder);client=new pg.Client({connectionString:url});await client.connect();await client.query("insert into analytics_ingestion_counter(singleton,position) values(true,17)");
  writeFileSync(join(folder,"meta/_journal.json"),JSON.stringify(journal));const tag=journal.entries.find(e=>e.idx===35)!.tag;
  appendFileSync(join(folder,`${tag}.sql`),"\n--> statement-breakpoint\nSELECT r20_synthetic_migration_failure();");
  await expect(runMigrations(url,folder)).rejects.toThrow();
  expect((await client.query("select to_regclass('analytics_ingestion_prune_coverage') table_name")).rows[0]!.table_name).toBeNull();
  expect((await client.query("select position::text from analytics_ingestion_counter")).rows[0]!.position).toBe("17");
  await runMigrations(url);await runMigrations(url);
  expect((await client.query("select count(*)::int n from drizzle.__drizzle_migrations")).rows[0]!.n).toBe(36);
  expect((await client.query("select position::text from analytics_ingestion_counter")).rows[0]!.position).toBe("17");
 }finally{await client?.end();await dropIntegrationDatabase(name);rmSync(folder,{recursive:true});}
});

it("does not resurrect a pruned idempotency key in a different stream",async()=>{
 const old=await seed();await pruneAdmissionHistory(f.db,producer.ctx,1000);expect(await exists(old)).toBe(false);
 const service=new IngestionAdmissions(f.db,f.h.app.get(AgentGatewayService));const podUid=randomUUID(),stream=await service.open(producer.token,podUid),requestId=randomUUID().replaceAll("-","");
 const hex=createHash("sha256").update(producer.source.clusterId+"|"+podUid+"|"+requestId).digest("hex").slice(0,32),id=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
 const ts=(await f.h.sql.query(`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ts`)).rows[0]!.ts as string;
 const copy={schemaVersion:1 as const,copyId:randomUUID(),podUid,requestId,event:{id,ts,environmentId:f.instanceId,clusterId:producer.source.clusterId,routeId:f.routeId,serviceId:f.serviceId,consumerId:null,method:"GET",path:"/same",status:200,latencyKongMs:1,latencyUpstreamMs:null,latencyTotalMs:2,clientIp:"2001:db8::1",requestSize:"1",responseSize:"1",retentionDays:7}};
 await expect(service.prepare(producer.token,stream.id,old,[copy])).rejects.toMatchObject({status:409});
});
