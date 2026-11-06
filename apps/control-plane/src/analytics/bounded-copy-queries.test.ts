import type {ClickHouseClient} from '@clickhouse/client';
import {expect,it,vi} from 'vitest';
import {BoundedCopyQueries} from './bounded-copy-queries.js';
const summary=(elapsed:string)=>({'x-clickhouse-summary':JSON.stringify({read_rows:'0',read_bytes:'0',elapsed_ns:elapsed})});
it('includes acknowledged INSERT execution in the same five-second database budget as SELECT',async()=>{
 const insert=vi.fn(async()=>({executed:true,query_id:'00000000-0000-4000-8000-000000000001',response_headers:summary('3000000000')}));
 const query=vi.fn(async(_params:Parameters<ClickHouseClient['query']>[0])=>({response_headers:summary('3000000000'),stream:async function*(){},close:vi.fn()}));
 const client={insert,query} as unknown as ClickHouseClient,reads=new BoundedCopyQueries(client),writes=reads.withSession(client,'synthetic-established-session');
 await writes.insert({table:'requests_v2_copies',format:'JSONEachRow',values:[]});expect(reads.usage.dbElapsedNs).toBe(3000000000);
 await expect(reads.query('SELECT 1',{},1)).rejects.toMatchObject({code:'analytics-budget-exceeded'});
 expect(query.mock.calls[0]![0].clickhouse_settings!.max_execution_time).toBeLessThanOrEqual(2);
});
it('does not accept a write without final engine accounting',async()=>{
 const client={insert:vi.fn(async()=>({executed:true,query_id:'synthetic',response_headers:{}}))} as unknown as ClickHouseClient;
 await expect(new BoundedCopyQueries(client).insert({table:'requests_v2_copies',format:'JSONEachRow',values:[]})).rejects.toMatchObject({code:'analytics-not-ready'});
});

for(const stage of ['insert-request','insert-accounting','select-request','select-stream','select-accounting'] as const)it(`exposes only a safe ${stage} diagnostic while refusing persistence evidence`,async()=>{
 const unsafe=new Error('synthetic credential=DO_NOT_COPY payload=DO_NOT_COPY');
 const client={
  insert:async()=>{if(stage==='insert-request')throw unsafe;return {executed:true,query_id:'synthetic',response_headers:stage==='insert-accounting'?{}:summary('1')};},
  query:async()=>{if(stage==='select-request')throw unsafe;return {response_headers:stage==='select-accounting'?{}:summary('1'),stream:async function*(){if(stage==='select-stream')throw unsafe;},close:()=>{}};}
 } as unknown as ClickHouseClient;
 const queries=new BoundedCopyQueries(client);
 const operation=stage.startsWith('insert-')?queries.insert({table:'requests_v2_copies',format:'JSONEachRow',values:[]}):queries.query('SELECT 1',{},1);
 const error=await operation.catch((error:unknown)=>error);
 expect(error).toMatchObject({stage,code:'analytics-not-ready'});
 expect(String(error)+JSON.stringify(error)).not.toMatch(/DO_NOT_COPY|credential|payload/);
});
