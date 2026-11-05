import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { inventoryMigrations } from './migrations.mjs';
const root=fileURLToPath(new URL('../../apps/control-plane/drizzle/',import.meta.url));
test('inventories the actual source SQL/journal and never assumes the live schema is current',async()=>{
 const r=await inventoryMigrations(root,null);assert.equal(r.status,'UNKNOWN_LIVE_SCHEMA');assert.ok(r.files.some(f=>f.name==='0028_analytics_route_history.sql'));assert.ok(r.files.some(f=>f.name==='0029_route_history_visibility.sql'));assert.equal(r.liveSchemaVerified,false);
});
test('ledger hashes are required and modified/missing migration history blocks compatibility',async()=>{
 const r=await inventoryMigrations(root,null);const ledger={source:'authenticated-plan-identity',files:r.files.map(f=>({name:f.name,sha256:f.sha256})),verified:true};
 const good=await inventoryMigrations(root,ledger);assert.equal(good.status,'NO_PENDING_MIGRATIONS');assert.equal(good.liveSchemaVerified,true);
 ledger.files[0].sha256='0'.repeat(64);await assert.rejects(inventoryMigrations(root,ledger),/modified|history/i);
});
