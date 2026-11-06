import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {AnalyticsRequestBudget} from './analytics-request-budget.js';
it('refuses the next stage before I/O when PostgreSQL preflight consumed the query allowance',()=>{
 const b=new AnalyticsRequestBudget(undefined,{maxPostgresQueries:1});
 try{const q=b.beginPostgres();q([{id:'synthetic'}]);expect(()=>b.beginPostgres()).toThrow('budget');expect(b.usage.postgresQueries).toBe(1);}finally{b.close();}
});
it('does not give simultaneous stages the same remaining execution reservation',()=>{
 const b=new AnalyticsRequestBudget();try{const finish=b.beginPostgres();expect(()=>b.beginClickHouse()).toThrow('budget');expect(()=>finish([])).toThrow('budget');}finally{b.close();}
});
it('keeps result rows, transport bytes, materialization and engine reads as different units',()=>{
 const b=new AnalyticsRequestBudget(undefined,{maxPostgresResultRows:1,maxPostgresWireBytes:16});
 try{b.receivePostgres(8);const finish=b.beginPostgres();finish([{id:'a'}]);expect(b.usage.postgresResultRows).toBe(1);expect(b.usage.postgresWireBytes).toBe(8);expect(b.clickhouse.readRows).toBe(0);expect(b.postgresPhysicalReadsProven).toBe(false);expect(()=>b.receivePostgres(9)).toThrow('budget');}finally{b.close();}
});
it('refuses oversized output without returning a partial result',()=>{
 const b=new AnalyticsRequestBudget(undefined,{maxResponseBytes:8});try{expect(()=>b.serialize({secret:'synthetic'})).toThrow('budget');expect(b.signal.aborted).toBe(true);}finally{b.close();}
});
it('retains cancellation and failure instead of resetting the budget for a later page',()=>{
 const a=new AbortController(),b=new AnalyticsRequestBudget(a.signal);a.abort();try{expect(()=>b.beginPostgres()).toThrow();expect(()=>b.beginClickHouse()).toThrow();}finally{b.close();}
});
it('keeps the original physical serving gate closed and requires an explicit proposed operational profile',()=>{
 const old=new AnalyticsRequestBudget(),proposed=new AnalyticsRequestBudget(undefined,{},'operational-v1-proposed');
 try{expect(()=>old.assertServingContract()).toThrow();expect(()=>proposed.assertServingContract()).not.toThrow();expect(proposed.profile).toBe('operational-v1-proposed');expect(proposed.postgresPhysicalReadsProven).toBe(false);}finally{old.close();proposed.close();}
});
it('shares a query count across PostgreSQL and ClickHouse before the next I/O',()=>{
 const b=new AnalyticsRequestBudget(undefined,{maxDatabaseQueries:1},'operational-v1-proposed');
 try{b.beginPostgres()([]);expect(()=>b.beginClickHouse()).toThrow('budget');expect(b.usage.postgresQueries).toBe(1);expect(b.usage.clickhouseQueries).toBe(0);}finally{b.close();}
});
it('refuses a late synchronous result even before the deadline timer can run',()=>{
 const clock=vi.spyOn(performance,'now').mockReturnValue(0),b=new AnalyticsRequestBudget(undefined,{},'operational-v1-proposed');
 try{clock.mockReturnValue(4500);expect(()=>b.check()).toThrow('budget');expect(b.signal.aborted).toBe(true);}finally{clock.mockRestore();b.close();}
});
it('implements the exact proposed operational ceilings without widening the integrated profile',()=>{
 const proposal=JSON.parse(readFileSync(new URL('../../../../contracts/analytics-operational-budget-proposal.json',import.meta.url),'utf8')) as {profile:'operational-v1-proposed';request:{databaseQueries:number;databaseMs:number;postgresResultRows:number;postgresWireBytes:number;materializedJsonBytes:number;responseBytes:number}};
 const values={maxDatabaseQueries:proposal.request.databaseQueries,maxDatabaseMs:proposal.request.databaseMs,maxPostgresResultRows:proposal.request.postgresResultRows,maxPostgresWireBytes:proposal.request.postgresWireBytes,maxMaterializedBytes:proposal.request.materializedJsonBytes,maxResponseBytes:proposal.request.responseBytes};
 const accepted=new AnalyticsRequestBudget(undefined,values,proposal.profile);try{expect(()=>accepted.assertServingContract()).not.toThrow();}finally{accepted.close();}
 for(const [key,value] of Object.entries(values))expect(()=>new AnalyticsRequestBudget(undefined,{...values,[key]:value+1},proposal.profile)).toThrow('budget');
});
