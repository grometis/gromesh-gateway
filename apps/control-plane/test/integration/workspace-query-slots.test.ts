import pg from "pg";
import {randomUUID} from "node:crypto";
import {afterAll,beforeAll,expect,it} from "vitest";
import {createIntegrationDatabase,dropIntegrationDatabase,integrationDatabaseName} from "./databases.js";
import {pgQueryBarrier} from "./pg-query-barrier.js";
import {withWorkspaceQuerySlots,type VerifiedWorkspaceRequestInput} from "../../src/analytics/workspace-request-serving.js";
let url:string,name:string,admin:pg.Client;
beforeAll(async()=>{name=integrationDatabaseName('r22slots');url=await createIntegrationDatabase(name);admin=new pg.Client({connectionString:url});await admin.connect();});
afterAll(async()=>{await admin?.end();if(name)await dropIntegrationDatabase(name);});
const input=(signal:AbortSignal):VerifiedWorkspaceRequestInput=>({instanceId:randomUUID(),workspaceId:randomUUID(),principalId:randomUUID(),role:'viewer',query:{from:'2026-01-01T00:00:00.000Z',to:'2026-01-01T01:00:00.000Z',limit:1},issueCursor:()=>'',signal});
it('cancels query-slot cleanup while its real PostgreSQL unlock message is held',async()=>{
 const proxy=await pgQueryBarrier(url,text=>text.includes('pg_advisory_unlock(')),pool=new pg.Pool({connectionString:proxy.url,max:1}),abort=new AbortController();
 let watchdog:ReturnType<typeof setTimeout>|undefined;
 const outcome=withWorkspaceQuerySlots(pool,input(abort.signal),async()=>42).then(()=>({kind:'success'}),()=>({kind:'rejected'}));
 try{
  await proxy.seen;
  const backend=(await admin.query<{pid:number}>("select pid from pg_stat_activity where datname=current_database() and application_name like 'gromesh-analytics-query:%'")).rows[0]!;
  expect(backend).toBeDefined();abort.abort();
  const result=await Promise.race([outcome,new Promise(resolve=>{watchdog=setTimeout(()=>resolve({kind:'deadline-exceeded'}),1500);})]);
  expect(result).toEqual({kind:'rejected'});
  expect((await admin.query('select 1 from pg_stat_activity where pid=$1',[backend.pid])).rowCount).toBe(0);
  expect((await admin.query('select 1 from pg_locks where pid=$1',[backend.pid])).rowCount).toBe(0);
 }finally{clearTimeout(watchdog);proxy.release();abort.abort();await outcome;await pool.end();await proxy.close();}
});
it('rejects an already cancelled request before invoking storage work',async()=>{
 const pool=new pg.Pool({connectionString:url,max:1}),abort=new AbortController();abort.abort();let ran=false;
 try{await expect(withWorkspaceQuerySlots(pool,input(abort.signal),async()=>{ran=true;})).rejects.toThrow();expect(ran).toBe(false);expect(pool.totalCount).toBe(0);}finally{await pool.end();}
});
