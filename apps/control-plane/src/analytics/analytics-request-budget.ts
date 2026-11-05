import type pg from 'pg';
import {StorageConsistencyError} from './storage-consistency.js';
const exceeded=()=>new StorageConsistencyError('analytics-budget-exceeded','Analytics operation budget exceeded');
interface Limits{maxPostgresQueries:number;maxPostgresResultRows:number;maxPostgresWireBytes:number;maxMaterializedBytes:number;maxResponseBytes:number;maxDatabaseMs:number}
const ceilings:Limits={maxPostgresQueries:200,maxPostgresResultRows:20000,maxPostgresWireBytes:2*1024*1024,maxMaterializedBytes:16*1024*1024,maxResponseBytes:2*1024*1024,maxDatabaseMs:5000};
/** One operation, separate units. PG wire/results are NOT evidence of physical PG table/index reads. */
export class AnalyticsRequestBudget{
 readonly usage={postgresQueries:0,postgresResultRows:0,postgresWireBytes:0,materializedBytes:0,responseBytes:0,databaseMs:0};
 readonly clickhouse={readRows:0,readBytes:0,decodedBytes:0,dbElapsedNs:0};
 readonly postgresPhysicalReadsProven=false;
 private readonly abort=new AbortController();readonly signal:AbortSignal;
 private readonly limits:Limits;private inFlight=false;private readonly timer:ReturnType<typeof setTimeout>;
 private readonly stageTimers=new Set<ReturnType<typeof setTimeout>>();
 private failure:StorageConsistencyError|undefined;
 constructor(caller?:AbortSignal,limits:Partial<Limits>={}){
  this.limits={...ceilings,...limits};
  for(const k of Object.keys(ceilings) as (keyof Limits)[])if(!Number.isSafeInteger(this.limits[k])||this.limits[k]<1||this.limits[k]>ceilings[k])throw exceeded();
  this.signal=AbortSignal.any([this.abort.signal,...(caller?[caller]:[])]);
  // 500ms recovery is separately bounded; active work plus cleanup stays below the 8s contract wall limit.
  this.timer=setTimeout(()=>this.abort.abort(),4500);
 }
 close(){clearTimeout(this.timer);for(const timer of this.stageTimers)clearTimeout(timer);this.stageTimers.clear();}
 check(){if(this.failure)throw this.failure;this.signal.throwIfAborted();}
 private fail():never{this.failure=exceeded();this.abort.abort();throw this.failure;}
 get remainingDatabaseMs(){this.check();const remaining=this.limits.maxDatabaseMs-this.usage.databaseMs;if(remaining<=0)return this.fail();return remaining;}
 private reserve(){this.check();if(this.inFlight)return this.fail();this.remainingDatabaseMs;this.inFlight=true;}
 private finish(milliseconds:number){this.inFlight=false;this.usage.databaseMs+=milliseconds;if(!Number.isFinite(milliseconds)||milliseconds<0||this.usage.databaseMs>this.limits.maxDatabaseMs)this.fail();this.check();}
 materialize(value:unknown){this.check();const bytes=Buffer.byteLength(JSON.stringify(value,(_key,value:unknown)=>typeof value==='bigint'?value.toString():value));this.usage.materializedBytes+=bytes;if(this.usage.materializedBytes>this.limits.maxMaterializedBytes)this.fail();}
 serialize(value:unknown){this.check();this.materialize(value);this.usage.responseBytes=Buffer.byteLength(JSON.stringify(value));if(this.usage.responseBytes>this.limits.maxResponseBytes)this.fail();this.check();}
 receivePostgres(bytes:number){this.check();this.usage.postgresWireBytes+=bytes;if(this.usage.postgresWireBytes>this.limits.maxPostgresWireBytes)this.fail();}
 beginPostgres(){this.reserve();if(this.usage.postgresQueries>=this.limits.maxPostgresQueries){this.inFlight=false;return this.fail();}this.usage.postgresQueries++;const started=performance.now();let done=false;
  const timer=setTimeout(()=>{try{this.fail();}catch{/* Signal abort retires the underlying owned session. */}},this.remainingDatabaseMs);this.stageTimers.add(timer);
  return(rows?:readonly unknown[])=>{if(done)return;done=true;clearTimeout(timer);this.stageTimers.delete(timer);this.inFlight=false;if(rows){this.usage.postgresResultRows+=rows.length;if(this.usage.postgresResultRows>this.limits.maxPostgresResultRows)this.fail();this.materialize(rows);}this.finish(performance.now()-started);};
 }
 beginClickHouse(){this.reserve();const started=performance.now();let done=false;return(elapsedNs?:number)=>{if(done)return;done=true;this.finish(elapsedNs===undefined?performance.now()-started:elapsedNs/1e6);};}
 /** Install only while a session belongs exclusively to this operation; restored before pooling. */
 instrument(client:pg.PoolClient){
  const original=client.query,connection:unknown=Reflect.get(client,'connection');
  const stream:unknown=connection&&typeof connection==='object'?Reflect.get(connection,'stream'):undefined;
  if(!stream||typeof stream!=='object'||typeof Reflect.get(stream,'on')!=='function'||typeof Reflect.get(stream,'removeListener')!=='function')throw exceeded();
  const receive=(chunk:unknown)=>{try{if(!Buffer.isBuffer(chunk))this.fail();this.receivePostgres(chunk.length);}catch{this.abort.abort();}};
  Reflect.apply(Reflect.get(stream,'on') as (...args:unknown[])=>unknown,stream,['data',receive]);
  client.query=(async(...args:unknown[])=>{
   const finish=this.beginPostgres();
   try{const result:unknown=await Reflect.apply(original,client,args);if(!result||typeof result!=='object'||!('rows' in result)||!Array.isArray(result.rows))throw exceeded();finish(result.rows);return result;}
   catch(error){finish();throw error;}
  }) as typeof client.query;
  return()=>{client.query=original;Reflect.apply(Reflect.get(stream,'removeListener') as (...args:unknown[])=>unknown,stream,['data',receive]);};
 }
}
