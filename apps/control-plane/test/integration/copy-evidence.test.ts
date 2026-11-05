import { randomUUID } from "node:crypto";
import { beforeAll,afterAll,it,expect } from "vitest";
import { IngestionAdmissions } from "../../src/analytics/ingestion-admissions.js";
import { AgentGatewayService } from "../../src/agent-gateway/agent-gateway.js";
import { authorizeClusterDelivery,confirmClusterAssociation } from "../../src/analytics/cluster-history.js";
import { recordCopyEvidence,readCopyEvidence,pruneCopyEvidence,type CopyObservation } from "../../src/analytics/copy-evidence.js";
import { clusterHistoryFixture } from "./cluster-history-fixtures.js";
import type { RequestContext } from "../../src/auth/auth.js";
let f:Awaited<ReturnType<typeof clusterHistoryFixture>>,streamId:string;
const ctx:RequestContext={actor:{type:"system",id:"analytics-copy-observer"},role:"viewer",ip:null};
const future="2099-01-01T00:00:00.000Z",expired="2020-01-01T00:00:00.000Z";
beforeAll(async()=>{f=await clusterHistoryFixture();const producer=await f.registered();const auth=await f.db.transaction(tx=>authorizeClusterDelivery(tx,producer.ctx,producer.source));await confirmClusterAssociation(f.db,auth);streamId=(await new IngestionAdmissions(f.db,f.h.app.get(AgentGatewayService)).open(producer.token,randomUUID())).id;});
afterAll(async()=>{await f?.close();});
/** Synthetic admission descriptors for repository/expiry tests; NOT a claim of producer/CH evidence. */
async function seed(id:string,expiresAt:string){const client=await f.h.sql.connect(),batch=randomUUID();try{await client.query("begin");await client.query("insert into analytics_ingestion_counter(singleton,position)values(true,0)on conflict do nothing");const generation=(await client.query<{position:string}>("update analytics_ingestion_counter set position=position+1 returning position::text")).rows[0]!.position;
await client.query("insert into analytics_ingestion_batches(id,stream_id,generation,descriptor)values($1,$2,$3,$4)",[batch,streamId,generation,JSON.stringify([{copyId:randomUUID(),id,commitment:"a".repeat(64),expiresAt}])]);await client.query("commit");return {batch,generation};}catch(e){await client.query("rollback");throw e;}finally{client.release();}}
async function liveExpiry(days=1){return (await f.h.sql.query<{at:string}>(`select to_char((clock_timestamp()+($1||' days')::interval) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at`,[days])).rows[0]!.at;}
const observation=(id:string,expiresAt:string,kind:"conflicting-copies"|"comparison-unavailable"="conflicting-copies"):CopyObservation=>({id,kind,expiresAt,leftHash:"a".repeat(64),rightHash:kind==="conflicting-copies"?"b".repeat(64):null});
it("persists compact negative evidence and makes exact retries idempotent",async()=>{
 const id=randomUUID(),expiresAt=await liveExpiry(),s=await seed(id,expiresAt),o=observation(id,expiresAt);
 expect(await recordCopyEvidence(f.db,ctx,s.batch,[o])).toMatchObject({inserted:1});expect(await recordCopyEvidence(f.db,ctx,s.batch,[o])).toMatchObject({inserted:0});
 const read=await readCopyEvidence(f.db,[id]);expect(read.items).toHaveLength(1);expect(read.items[0]).toMatchObject({id,kind:"conflicting-copies"});
 const rows=(await f.h.sql.query("select * from analytics_copy_evidence where request_id=$1",[id])).rows;expect(rows).toHaveLength(1);expect(JSON.stringify(rows)).not.toMatch(/clientIp|path|headers|Bearer|requestSize|payload/);
});
it("never treats equal commitments as proof of a conflict",async()=>{
 const id=randomUUID(),e=await liveExpiry(),s=await seed(id,e);await expect(recordCopyEvidence(f.db,ctx,s.batch,[{...observation(id,e),rightHash:"a".repeat(64)}])).rejects.toThrow();
 expect((await readCopyEvidence(f.db,[id])).items).toEqual([]);
});
it("records missing comparison separately and keeps a later confirmed conflict",async()=>{
 const id=randomUUID(),e=await liveExpiry(),s=await seed(id,e);await recordCopyEvidence(f.db,ctx,s.batch,[observation(id,e,"comparison-unavailable")]);expect((await readCopyEvidence(f.db,[id])).items[0]!.kind).toBe("comparison-unavailable");
 await recordCopyEvidence(f.db,ctx,s.batch,[observation(id,e)]);expect((await readCopyEvidence(f.db,[id])).items[0]!.kind).toBe("conflicting-copies");
});
it("merges concurrent observations and preserves the largest original expiry",async()=>{
 const id=randomUUID(),short=await liveExpiry(1),long=await liveExpiry(2),a=await seed(id,short),b=await seed(id,long);
 await Promise.all([recordCopyEvidence(f.db,ctx,a.batch,[observation(id,short)]),recordCopyEvidence(f.db,ctx,b.batch,[observation(id,long)]),recordCopyEvidence(f.db,ctx,a.batch,[observation(id,short)])]);
 const row=(await readCopyEvidence(f.db,[id])).items[0]!;expect(Date.parse(row.expiresAt)).toBe(Date.parse(long));expect((await f.h.sql.query("select count(*)::int as n from analytics_copy_evidence where request_id=$1",[id])).rows[0]!.n).toBe(2);
});
it("rejects observations outside the admitted ids, shortened or unbounded retention",async()=>{
 const id=randomUUID(),e=await liveExpiry(2),s=await seed(id,e);
 for(const o of [observation(randomUUID(),e),observation(id,expired),observation(id,future)])await expect(recordCopyEvidence(f.db,ctx,s.batch,[o])).rejects.toThrow();
});
it("rolls back evidence and audit together on an injected write failure",async()=>{
 const id=randomUUID(),e=await liveExpiry(),s=await seed(id,e);await f.h.sql.query(`create function fail_copy_fact() returns trigger language plpgsql as $$begin if NEW.action='analytics.copy-evidence.record' then raise exception 'synthetic audit failure';end if;return NEW;end$$;create trigger fail_copy_fact before insert on audit_events for each row execute function fail_copy_fact()`);
 try{await expect(recordCopyEvidence(f.db,ctx,s.batch,[observation(id,e)])).rejects.toThrow();}finally{await f.h.sql.query("drop trigger fail_copy_fact on audit_events;drop function fail_copy_fact()");}
 expect((await readCopyEvidence(f.db,[id])).items).toEqual([]);
});
it("prunes only expired facts in bounded idempotent batches and marks lost coverage",async()=>{
 const id=randomUUID(),s=await seed(id,expired);await recordCopyEvidence(f.db,ctx,s.batch,[observation(id,expired)]);
 const active=randomUUID(),e=await liveExpiry(),s2=await seed(active,e);await recordCopyEvidence(f.db,ctx,s2.batch,[observation(active,e)]);
 expect((await pruneCopyEvidence(f.db,ctx,1)).removed).toBe(1);expect((await readCopyEvidence(f.db,[id])).historyPruned).toBe(true);expect((await readCopyEvidence(f.db,[active])).items).toHaveLength(1);expect((await pruneCopyEvidence(f.db,ctx,1)).removed).toBe(0);
 expect((await recordCopyEvidence(f.db,ctx,s.batch,[observation(id,expired)])).inserted).toBe(0);
});
it("a failed prune rolls back both deletion and coverage movement",async()=>{
 const id=randomUUID(),s=await seed(id,expired);await recordCopyEvidence(f.db,ctx,s.batch,[observation(id,expired)]);const before=(await f.h.sql.query("select pruned_through::text from analytics_copy_coverage")).rows;
 await f.h.sql.query(`create function fail_copy_prune() returns trigger language plpgsql as $$begin if NEW.action='analytics.copy-evidence.prune' then raise exception 'synthetic prune failure';end if;return NEW;end$$;create trigger fail_copy_prune before insert on audit_events for each row execute function fail_copy_prune()`);
 try{await expect(pruneCopyEvidence(f.db,ctx,100)).rejects.toThrow();}finally{await f.h.sql.query("drop trigger fail_copy_prune on audit_events;drop function fail_copy_prune()");}
 expect((await readCopyEvidence(f.db,[id])).items).toHaveLength(1);expect((await f.h.sql.query("select pruned_through::text from analytics_copy_coverage")).rows).toEqual(before);await pruneCopyEvidence(f.db,ctx,100);
});
it("concurrent pruning skips a row held by another transaction instead of deleting live evidence",async()=>{
 const id=randomUUID(),s=await seed(id,expired);await recordCopyEvidence(f.db,ctx,s.batch,[observation(id,expired)]);const c=await f.h.sql.connect();try{await c.query("begin");await c.query("select id from analytics_copy_evidence where request_id=$1 for update",[id]);expect((await pruneCopyEvidence(f.db,ctx,1)).removed).toBe(0);}finally{await c.query("rollback");c.release();}expect((await pruneCopyEvidence(f.db,ctx,1)).removed).toBe(1);
});
it("rejects invalid query and prune budgets without pretending no evidence",async()=>{
 await expect(readCopyEvidence(f.db,["invalid"])).rejects.toThrow();await expect(readCopyEvidence(f.db,Array.from({length:201},()=>randomUUID()))).rejects.toThrow();for(const n of [0,1001,1.5])await expect(pruneCopyEvidence(f.db,ctx,n)).rejects.toThrow();
});
it("database guards reject updates, truncation, early deletion and loss-marker reset",async()=>{
 const id=randomUUID(),e=await liveExpiry(),s=await seed(id,e);await recordCopyEvidence(f.db,ctx,s.batch,[observation(id,e)]);
 for(const query of ["update analytics_copy_evidence set kind='comparison-unavailable' where request_id=$1","delete from analytics_copy_evidence where request_id=$1"])
 await expect(f.h.sql.query(query,[id])).rejects.toThrow();
 for(const query of ["truncate analytics_copy_evidence","truncate analytics_copy_coverage","delete from analytics_copy_coverage","update analytics_copy_coverage set pruned_through=0,pruned_at=null,prune_transaction=null"])
 await expect(f.h.sql.query(query)).rejects.toThrow();
});
