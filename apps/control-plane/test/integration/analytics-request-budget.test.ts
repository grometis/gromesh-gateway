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
