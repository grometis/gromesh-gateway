import pg from 'pg';
import {expect,it} from 'vitest';
import {integrationDatabaseName,createIntegrationDatabase,dropIntegrationDatabase} from './databases.js';
import {physicalCatalogLease} from './physical-fence-fixture.js';
it('keeps an exclusive catalog observer outside nested physical fixtures until both release',async()=>{
 const name=integrationDatabaseName("r22catalog"),url=await createIntegrationDatabase(name);
 const observer=new pg.Client({connectionString:url});await observer.connect();
 const outer=await physicalCatalogLease(url);let inner:(()=>Promise<void>)|undefined;
 try{
  expect((await observer.query('select pg_try_advisory_lock(21121,1) locked')).rows[0]!.locked).toBe(false);
  inner=await physicalCatalogLease(url);await outer();
  expect((await observer.query('select pg_try_advisory_lock(21121,1) locked')).rows[0]!.locked).toBe(false);
  await inner();expect((await observer.query('select pg_try_advisory_lock(21121,1) locked')).rows[0]!.locked).toBe(true);
 }finally{await outer();await inner?.();await observer.query('select pg_advisory_unlock_all()');await observer.end();await dropIntegrationDatabase(name);}
});
