import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
const read=name=>JSON.parse(readFileSync(new URL(`../${name}`,import.meta.url),'utf8'));
const profile=read('analytics-operational-budget-proposal.json');
test('proposes a distinct operational profile without claiming physical reads',()=>{
 assert.equal(profile.status,'proposed-not-approved');assert.equal(profile.profile,'operational-v1-proposed');
 assert(profile.excludes.includes('postgres-physical-read-accounting'));assert(profile.excludes.includes('delivery-complete-from-kong'));
 assert.equal(profile.request.databaseQueries,200);assert.equal(profile.request.activeMs,4500);assert.equal(profile.request.wallMs,8000);
 assert.equal(profile.request.databaseMs,5000);assert.equal(profile.postgres.temporaryFileBytes,0);
 assert.equal(profile.clickhouse.readRows,5000000);assert.equal(profile.clickhouse.readBytes,268435456);
 assert.equal(profile.request.responseBytes,2097152);assert.equal(profile.recovery.attemptMs,500);
});
test('does not silently replace the integrated physical contract',()=>{
 const design=readFileSync(new URL('../analytics-v2-design.md',import.meta.url),'utf8');
 assert.match(design,/5 milhões de linhas lidas/);assert.match(design,/256MiB lidos agregando todas as queries internas/);
 const openapi=readFileSync(new URL('../control-plane-v2.openapi.yaml',import.meta.url),'utf8');
 assert(!openapi.includes(profile.profile));
});
