import pg from "pg";
import {createServer,createConnection,type Socket} from "node:net";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
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
it.each(['hostless','socket','path'] as const)('cancels actual PostgreSQL work through a driver-supported %s Unix connection',async kind=>{
 const target=new URL(url),directory=mkdtempSync('/tmp/gromesh-pg-cancel-'),connections=new Set<Socket>();
 const server=createServer(incoming=>{
  const upstream=createConnection({host:target.hostname,port:Number(target.port)});
  connections.add(incoming);connections.add(upstream);
  incoming.on('error',()=>upstream.destroy());upstream.on('error',()=>incoming.destroy());
  incoming.on('close',()=>{connections.delete(incoming);upstream.destroy();});
  upstream.on('close',()=>{connections.delete(upstream);incoming.destroy();});
  incoming.pipe(upstream);upstream.pipe(incoming);
 });
 let pool:pg.Pool|undefined,backend:{pid:number;name:string}|undefined,reading:Promise<unknown>|undefined;
 const abort=new AbortController();
 try{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(join(directory,`.s.PGSQL.${target.port}`),resolve);});
  const database=target.pathname.slice(1),query=new URLSearchParams({host:directory,port:target.port,query_timeout:'600000',statement_timeout:'600000'});
  const connectionString=kind==='hostless'?`postgres://${target.username}:${target.password}@/${database}?${query}`:
   kind==='socket'?`socket:${directory}?db=${database}&port=${target.port}&query_timeout=600000&statement_timeout=600000`:`${directory} ${database}`;
  // Socket DSNs carry no password; authenticate the original driver path through its supported env fallback.
  vi.stubEnv('PGPASSWORD',decodeURIComponent(target.password));
  vi.stubEnv('PGUSER',decodeURIComponent(target.username));
  pool=new pg.Pool({connectionString,user:decodeURIComponent(target.username),password:decodeURIComponent(target.password),port:Number(target.port),max:1});
  await pool.query('select 1');
  reading=withIngestionReadSnapshot(pool,db=>db.execute(sql.raw('select pg_sleep(30)')),abort.signal).then(()=>({ok:true}),()=>({ok:false}));
  const deadline=performance.now()+2500;
  while(performance.now()<deadline){backend=(await admin.query<{pid:number;name:string}>("select pid,application_name name from pg_stat_activity where datname=current_database() and application_name like 'gromesh-analytics-read:%' and state='active' and query='select pg_sleep(30)' limit 1")).rows[0];if(backend)break;}
  expect(backend).toBeDefined();abort.abort();expect(await reading).toEqual({ok:false});
  expect((await admin.query('select 1 from pg_stat_activity where pid=$1 and application_name=$2',[backend!.pid,backend!.name])).rowCount).toBe(0);
  const locked=(await admin.query<{locked:boolean}>('select pg_try_advisory_lock(1818,1801) locked')).rows[0]!.locked;
  try{expect(locked).toBe(true);}finally{if(locked)await admin.query('select pg_advisory_unlock(1818,1801)');}
 }finally{
  abort.abort();if(backend)await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where pid=$1 and application_name=$2 and datname=current_database() and usename=current_user',[backend.pid,backend.name]);
  await reading;await pool?.end();for(const socket of connections)socket.destroy();
  if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  rmSync(directory,{recursive:true});
 }
});

it('cancels during blocked session cleanup without releasing the wire barrier or returning a late result',async()=>{
 const {pgQueryBarrier}=await import('./pg-query-barrier.js');
 const proxy=await pgQueryBarrier(url,text=>text==='reset lock_timeout'),pool=new pg.Pool({connectionString:proxy.url,max:1}),abort=new AbortController();
 let pid=0,watchdog:ReturnType<typeof setTimeout>|undefined;
 const outcome=withIngestionReadSnapshot(pool,async db=>{pid=(await db.execute<{pid:number}>(sql`select pg_backend_pid() pid`)).rows[0]!.pid;return 'must-not-escape';},abort.signal).then(value=>({kind:'success',value}),()=>({kind:'rejected'}));
 try{
  await proxy.seen; abort.abort();
  const result=await Promise.race([outcome,new Promise(resolve=>{watchdog=setTimeout(()=>resolve({kind:'deadline-exceeded'}),1500);})]);
  expect(result).toEqual({kind:'rejected'});
  expect((await admin.query('select 1 from pg_stat_activity where pid=$1',[pid])).rowCount).toBe(0);
  const locked=(await admin.query<{locked:boolean}>('select pg_try_advisory_lock(1818,1801) locked')).rows[0]!.locked;
  try{expect(locked).toBe(true);}finally{if(locked)await admin.query('select pg_advisory_unlock(1818,1801)');}
 }finally{clearTimeout(watchdog);proxy.release();abort.abort();await outcome;await pool.end();await proxy.close();}
});


it('bounds cancellation recovery when the independent control connection is unavailable',async()=>{
 const {pgQueryBarrier}=await import('./pg-query-barrier.js');
 const proxy=await pgQueryBarrier(url,text=>text==='reset lock_timeout'),pool=new pg.Pool({connectionString:proxy.url,max:1}),abort=new AbortController();
 let pid=0;
 const outcome=withIngestionReadSnapshot(pool,async db=>{pid=(await db.execute<{pid:number}>(sql`select pg_backend_pid() pid`)).rows[0]!.pid;return 'late';},abort.signal).then(()=>true,()=>false);
 try{
  await proxy.seen;const started=performance.now();proxy.disconnect();abort.abort();
  expect(await outcome).toBe(false);expect(performance.now()-started).toBeLessThan(1250);
  // Loss of the inactive session transport releases its server lock even without the control path.
  await vi.waitFor(async()=>expect((await admin.query('select 1 from pg_stat_activity where pid=$1',[pid])).rowCount).toBe(0));
  expect(pool.totalCount).toBe(0);
 }finally{proxy.release();abort.abort();await outcome;await pool.end();await proxy.close();}
});
it('rejects a cleanup failure and recovers with the next pooled request',async()=>{
 const {pgQueryBarrier}=await import('./pg-query-barrier.js');
 const proxy=await pgQueryBarrier(url,text=>text==='reset lock_timeout'),pool=new pg.Pool({connectionString:proxy.url,max:1});
 const outcome=withIngestionReadSnapshot(pool,async()=>true).then(()=>true,()=>false);
 try{await proxy.seen;proxy.disconnect();expect(await outcome).toBe(false);expect(pool.totalCount).toBe(0);}
 finally{proxy.release();await outcome;await pool.end();await proxy.close();}
 const healthy=new pg.Pool({connectionString:url,max:1});
 try{expect(await withIngestionReadSnapshot(healthy,async db=>(await db.execute<{value:number}>(sql`select 42 value`)).rows[0]!.value)).toBe(42);}finally{await healthy.end();}
});
it('does not retain snapshot lifecycle listeners on a healthy reused connection',async()=>{
 const pool=new pg.Pool({connectionString:url,max:1});
 try{
  const probe=await pool.connect(),baseline={end:probe.listenerCount('end'),error:probe.listenerCount('error')};probe.release();
  for(let n=0;n<12;n++)expect(await withIngestionReadSnapshot(pool,async()=>42)).toBe(42);
  const reused=await pool.connect();try{expect(reused.listenerCount('end')).toBe(baseline.end);expect(reused.listenerCount('error')).toBe(baseline.error);}finally{reused.release();}
 }finally{await pool.end();}
});
