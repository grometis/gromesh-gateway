import pg from "pg";
import{randomUUID}from"node:crypto";
import{sql}from"drizzle-orm";
import{afterAll,afterEach,beforeAll,expect,it,vi}from"vitest";
import{createIntegrationDatabase,dropIntegrationDatabase,integrationDatabaseName}from"./databases.js";
import{withIngestionReadSnapshot}from"../../src/analytics/ingestion-read-snapshot.js";
import{ingestionCancellationConfig}from"../../src/analytics/ingestion-cancellation.js";
let name:string,url:string,admin:pg.Client;
beforeAll(async()=>{name=integrationDatabaseName('r20cancel');url=await createIntegrationDatabase(name);admin=new pg.Client({connectionString:url});await admin.connect();});
afterEach(()=>vi.unstubAllEnvs());afterAll(async()=>{await admin?.end();if(name)await dropIntegrationDatabase(name);});
it('authenticates the real cancellation connection for a pool configured by fields and releases its server lock',async()=>{
 vi.stubEnv('PGPASSWORD','synthetic-wrong-fallback');const target=new URL(url),pool=new pg.Pool({host:target.hostname,port:Number(target.port),user:decodeURIComponent(target.username),password:decodeURIComponent(target.password),database:target.pathname.slice(1),max:1}),abort=new AbortController();
 let backend:{pid:number;name:string}|undefined,exclusive=false;
 const outcome=withIngestionReadSnapshot(pool,db=>db.execute(sql.raw('select pg_sleep(30)')),abort.signal).then(()=>({ok:true}),()=>({ok:false}));
 try{
  const deadline=performance.now()+2500;
  while(performance.now()<deadline){backend=(await admin.query<{pid:number;name:string}>("select pid,application_name name from pg_stat_activity where datname=current_database() and application_name like 'gromesh-analytics-read:%' and state='active' and query='select pg_sleep(30)' limit 1")).rows[0];if(backend)break;}
  expect(backend).toBeDefined();abort.abort();expect(await outcome).toEqual({ok:false});
  const until=performance.now()+2500;let active=true;
  while(performance.now()<until){active=(await admin.query('select 1 from pg_stat_activity where pid=$1 and application_name=$2',[backend!.pid,backend!.name])).rowCount!==0;if(!active)break;}
  expect(active).toBe(false);
  exclusive=(await admin.query<{locked:boolean}>('select pg_try_advisory_lock(1818,1801) locked')).rows[0]!.locked;expect(exclusive).toBe(true);
 }finally{abort.abort();if(backend)await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where pid=$1 and application_name=$2 and datname=current_database() and usename=current_user',[backend.pid,backend.name]);if(exclusive)await admin.query('select pg_advisory_unlock(1818,1801)');await outcome;await pool.end();}
});
it('enforces a real one-second control query timeout despite a ten-minute DSN override',async()=>{
 const target=new URL(url);target.searchParams.set('query_timeout','600000');target.searchParams.set('statement_timeout','600000');
 const pool=new pg.Pool({connectionString:target.toString()}),client=new pg.Client(ingestionCancellationConfig(pool));let pid=0,watchdogFired=false;
 const nonce='r20-cancel-control:'+randomUUID();let watchdog:ReturnType<typeof setTimeout>|undefined;
 try{
  await client.connect();await client.query("select set_config('application_name',$1,false)",[nonce]);pid=(await client.query<{pid:number}>('select pg_backend_pid() pid')).rows[0]!.pid;
  watchdog=setTimeout(()=>{watchdogFired=true;void client.end();},2500);
  let message='';try{await client.query('select pg_sleep(10)');}catch(error){message=error instanceof Error?error.message:'unknown';}
  expect(watchdogFired).toBe(false);expect(message).toMatch(/timeout/i);
 }finally{clearTimeout(watchdog);await client.end();if(pid)await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where pid=$1 and application_name=$2 and datname=current_database() and usename=current_user',[pid,nonce]);await pool.end();}
});
