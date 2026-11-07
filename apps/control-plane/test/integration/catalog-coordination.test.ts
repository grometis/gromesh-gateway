import pg from 'pg';
import {expect,it} from 'vitest';
import {integrationDatabaseName,createIntegrationDatabase,dropIntegrationDatabase} from './databases.js';
import {physicalCatalogLease} from './physical-fence-fixture.js';
it('keeps an exclusive catalog observer outside nested physical fixtures until both release',async()=>{
 const name=integrationDatabaseName("r22catalog"),url=await createIntegrationDatabase(name);
 const observer=new pg.Client({connectionString:url});let outer:(()=>Promise<void>)|undefined,inner:(()=>Promise<void>)|undefined;
 try{
  await observer.connect();outer=await physicalCatalogLease(url);
  expect((await observer.query('select pg_try_advisory_lock(21121,1) locked')).rows[0]!.locked).toBe(false);
  inner=await physicalCatalogLease(url);await outer();
  expect((await observer.query('select pg_try_advisory_lock(21121,1) locked')).rows[0]!.locked).toBe(false);
  await inner();expect((await observer.query('select pg_try_advisory_lock(21121,1) locked')).rows[0]!.locked).toBe(true);
 }finally{try{await outer?.();await inner?.();}finally{try{await observer.end();}finally{await dropIntegrationDatabase(name);}}}
});
