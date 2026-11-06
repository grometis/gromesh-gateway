import pg from 'pg';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createIntegrationDatabase,dropIntegrationDatabase,integrationDatabaseName} from './databases.js';
import {AnalyticsRequestBudget} from '../../src/analytics/analytics-request-budget.js';
import {withIngestionReadSnapshot} from '../../src/analytics/ingestion-read-snapshot.js';
let name:string,url:string,pool:pg.Pool;
beforeAll(async()=>{name=integrationDatabaseName('r22budget');url=await createIntegrationDatabase(name);pool=new pg.Pool({connectionString:url,max:1});});
afterAll(async()=>{await pool?.end();if(name)await dropIntegrationDatabase(name);});
it('shares actual PG wire/rows/query accounting across preflight and subsequent history snapshots',async()=>{
 const budget=new AnalyticsRequestBudget();
 try{
  await withIngestionReadSnapshot(pool,async db=>db.execute(sql`select 'synthetic-a' value`),budget.signal,budget);
  const first={...budget.usage};expect(first.postgresQueries).toBeGreaterThan(5);expect(first.postgresWireBytes).toBeGreaterThan(0);
  await withIngestionReadSnapshot(pool,async db=>db.execute(sql`select 'synthetic-b' value`),budget.signal,budget);
  expect(budget.usage.postgresQueries).toBeGreaterThan(first.postgresQueries);expect(budget.usage.postgresWireBytes).toBeGreaterThan(first.postgresWireBytes);
  expect(budget.usage.postgresResultRows).toBeGreaterThan(first.postgresResultRows);expect(budget.postgresPhysicalReadsProven).toBe(false);
 }finally{budget.close();}
});
it('rejects before the next SQL callback when a previous snapshot consumed the query allowance',async()=>{
 const budget=new AnalyticsRequestBudget(undefined,{maxPostgresQueries:13});let nextRan=false;
 try{
  await withIngestionReadSnapshot(pool,async db=>db.execute(sql`select 1`),budget.signal,budget);
  await expect(withIngestionReadSnapshot(pool,async()=>{nextRan=true;},budget.signal,budget)).rejects.toThrow();expect(nextRan).toBe(false);
 }finally{budget.close();}
});
it('cancels underlying PostgreSQL work when the remaining operation execution allowance expires',async()=>{
 const budget=new AnalyticsRequestBudget(undefined,{maxDatabaseMs:40});
 try{await expect(withIngestionReadSnapshot(pool,async db=>db.execute(sql`select pg_sleep(30)`),budget.signal,budget)).rejects.toThrow();expect(budget.signal.aborted).toBe(true);expect(pool.totalCount).toBe(0);}finally{budget.close();}
});

it('bounds PostgreSQL sort spill and per-operation resources without leaking settings into the pool',async()=>{
 const client=await pool.connect();const before=(await client.query("select current_setting('work_mem') work, current_setting('temp_file_limit') temp, current_setting('max_parallel_workers_per_gather') parallel")).rows[0];client.release();
 const budget=new AnalyticsRequestBudget();
 try{
  const settings=await withIngestionReadSnapshot(pool,async db=>(await db.execute<{work:string;temp:string;parallel:string;jit:string;hash:string}>(sql`select current_setting('work_mem') work,current_setting('temp_file_limit') temp,current_setting('max_parallel_workers_per_gather') parallel,current_setting('jit') jit,current_setting('hash_mem_multiplier') hash`)).rows[0]!,budget.signal,budget);
  expect(settings).toEqual({work:'1MB',temp:'0',parallel:'0',jit:'off',hash:'1'});
  await expect(withIngestionReadSnapshot(pool,async db=>db.execute(sql`select repeat(md5(i::text),16) payload from generate_series(1,10000) i order by payload`),budget.signal,budget)).rejects.toMatchObject({cause:{code:'53400'}});
  const next=await pool.connect();try{expect((await next.query("select current_setting('work_mem') work, current_setting('temp_file_limit') temp, current_setting('max_parallel_workers_per_gather') parallel")).rows[0]).toEqual(before);expect((await next.query('select 42 answer')).rows[0].answer).toBe(42);}finally{next.release();}
  expect(budget.postgresPhysicalReadsProven).toBe(false);
 }finally{budget.close();}
});

it('refuses the read before its callback if PostgreSQL cannot enforce the temporary-file ceiling',async()=>{
 const role=integrationDatabaseName('r23limited');await pool.query(`create role "${role}"`);
 const client=await pool.connect();await client.query(`set role "${role}"`);client.release();let ran=false;
 const budget=new AnalyticsRequestBudget();
 try{await expect(withIngestionReadSnapshot(pool,async()=>{ran=true;return 'unsafe';},budget.signal,budget)).rejects.toThrow();expect(ran).toBe(false);}
 finally{budget.close();const next=await pool.connect();try{await next.query('reset role');await next.query(`drop role "${role}"`);}finally{next.release();}}
});

it('uses an administrator-imposed zero spill ceiling without granting SET privileges to the reader',async()=>{
 const role=integrationDatabaseName('r23fixed');await pool.query(`create role "${role}"`);
 const client=await pool.connect();await client.query("set temp_file_limit='0'");await client.query(`set role "${role}"`);client.release();
 const budget=new AnalyticsRequestBudget();
 try{expect(await withIngestionReadSnapshot(pool,async db=>(await db.execute<{answer:number}>(sql`select 42 answer`)).rows[0]!.answer,budget.signal,budget)).toBe(42);}
 finally{budget.close();const next=await pool.connect();try{await next.query('reset role');await next.query('reset temp_file_limit');await next.query(`drop role "${role}"`);}finally{next.release();}}
});
