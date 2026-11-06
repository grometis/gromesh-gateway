import pg from 'pg';
import {expect,it} from 'vitest';
import {ADMIN_URL} from './databases.js';
import {physicalCatalogLease} from './physical-fence-fixture.js';
it('keeps an exclusive catalog observer outside nested physical fixtures until both release',async()=>{
 const observer=new pg.Client({connectionString:ADMIN_URL});await observer.connect();
 const outer=await physicalCatalogLease();let inner:(()=>Promise<void>)|undefined;
 try{
  expect((await observer.query('select pg_try_advisory_lock(21121,1) locked')).rows[0]!.locked).toBe(false);
  inner=await physicalCatalogLease();await outer();
  expect((await observer.query('select pg_try_advisory_lock(21121,1) locked')).rows[0]!.locked).toBe(false);
  await inner();expect((await observer.query('select pg_try_advisory_lock(21121,1) locked')).rows[0]!.locked).toBe(true);
 }finally{await outer();await inner?.();await observer.query('select pg_advisory_unlock_all()');await observer.end();}
});
