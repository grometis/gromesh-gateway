import {expect,it} from 'vitest';
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
