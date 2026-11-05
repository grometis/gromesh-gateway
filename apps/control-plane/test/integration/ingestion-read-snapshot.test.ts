import { afterAll,beforeAll,it,expect,vi } from "vitest";
import { sql } from "drizzle-orm";
import { withIngestionReadSnapshot,readAdmissionPrefix } from "../../src/analytics/ingestion-read-snapshot.js";
import { clusterHistoryFixture } from "./cluster-history-fixtures.js";
let f:Awaited<ReturnType<typeof clusterHistoryFixture>>;
beforeAll(async()=>{f=await clusterHistoryFixture();});afterAll(async()=>{await f?.close();});
it("observes the writer commit when the shared session lock waited before BEGIN",async()=>{
 const writer=await f.h.sql.connect();await writer.query("begin");await writer.query("select pg_advisory_xact_lock(1818,1801)");
 let observed:Promise<Awaited<ReturnType<typeof readAdmissionPrefix>>>|undefined;
 try{
  observed=withIngestionReadSnapshot(f.h.sql,db=>readAdmissionPrefix(db));
  // Synchronize on the real PG lock waiter rather than sleeping or assuming scheduling order.
  let waiting=false;const deadline=performance.now()+900;
  while(!waiting&&performance.now()<deadline){waiting=(await writer.query("select exists(select 1 from pg_locks where locktype='advisory' and classid=1818 and objid=1801 and mode='ShareLock' and not granted) as waiting")).rows[0]!.waiting;}
  expect(waiting).toBe(true);
  // Synthetic counter corruption: the read must see it after commit and report the missing position.
  await writer.query("insert into analytics_ingestion_counter(singleton,position)values(true,1)on conflict(singleton)do update set position=1");await writer.query("commit");
  expect(await observed).toMatchObject({acceptedThrough:"1",receiptThrough:"0",gapDetected:true,receiptPrefixComplete:false,copiesComplete:false,coherentSnapshot:false});
 }finally{await writer.query("rollback");writer.release();await observed?.catch(()=>undefined);}
});
it("releases the session lock and transaction after a reader exception",async()=>{
 await expect(withIngestionReadSnapshot(f.h.sql,async db=>{await db.execute(sql`select 1`);throw Error("synthetic reader failure");})).rejects.toThrow("synthetic reader failure");
 const c=await f.h.sql.connect();try{await c.query("begin");expect((await c.query("select pg_try_advisory_xact_lock(1818,1801) as unlocked")).rows[0]!.unlocked).toBe(true);}finally{await c.query("rollback");c.release();}
 await expect(withIngestionReadSnapshot(f.h.sql,db=>readAdmissionPrefix(db))).resolves.toMatchObject({deliveryFromKongComplete:false});
});
it("uses an actual repeatable-read read-only database view",async()=>{
 await withIngestionReadSnapshot(f.h.sql,async db=>{
  const row=(await db.execute<{isolation:string;readOnly:string}>(sql`select current_setting('transaction_isolation') isolation,current_setting('transaction_read_only') "readOnly"`)).rows[0]!;
  expect(row).toEqual({isolation:"repeatable read",readOnly:"on"});

 });
});

it("history helpers reject a pool query without an actual coherent read snapshot",async()=>{
 const {readCopyEvidenceSnapshot}=await import("../../src/analytics/copy-evidence.js");
 await expect(readCopyEvidenceSnapshot(f.db,[])).rejects.toThrow("coherent read-only snapshot");
 await expect(withIngestionReadSnapshot(f.h.sql,db=>db.execute(sql`update analytics_ingestion_counter set position=2`))).rejects.toThrow();
});

it("caller cancellation interrupts a real PG query and releases its session lock before more history can run",async()=>{
 const abort=new AbortController();let pid=0,continued=false;
 const result=withIngestionReadSnapshot(f.h.sql,async db=>{pid=(await db.execute<{pid:number}>(sql`select pg_backend_pid() pid`)).rows[0]!.pid;await db.execute(sql`select pg_sleep(60)`);continued=true;},abort.signal).then(()=>null,error=>error as unknown);
 await vi.waitFor(async()=>{expect(pid).toBeGreaterThan(0);expect((await f.h.sql.query("select wait_event from pg_stat_activity where pid=$1",[pid])).rows[0]?.wait_event).toBe("PgSleep");});
 abort.abort();expect(await result).toBeTruthy();expect(continued).toBe(false);
 await vi.waitFor(async()=>{const c=await f.h.sql.connect();try{await c.query("begin");expect((await c.query("select pg_try_advisory_xact_lock(1818,1801) unlocked")).rows[0]!.unlocked).toBe(true);}finally{await c.query("rollback");c.release();}});
});
it("an already aborted caller never begins a read transaction",async()=>{let called=false;const a=new AbortController();a.abort();await expect(withIngestionReadSnapshot(f.h.sql,async()=>{called=true;},a.signal)).rejects.toThrow();expect(called).toBe(false);});
