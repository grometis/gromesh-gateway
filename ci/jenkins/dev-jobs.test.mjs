import test from 'node:test';
import assert from 'node:assert/strict';
import { cdJobDefinitions,renderJobXml } from './jobs.mjs';
test('DEV and rollback definitions preserve their identities, use a nonadmin principal, and remain disabled',()=>{
 const jobs=cdJobDefinitions('a'.repeat(40));assert.equal(jobs.length,2);
 assert.deepEqual(jobs.map(j=>j.name),['gromesh-gateway/gromesh-dev/gromesh-deploy','gromesh-gateway/gromesh-dev/gromesh-rollback'],'J4 deployed job IDs must be preserved');
 for(const job of jobs){assert.equal(job.preserveExistingHistory,true);assert.equal(job.replaceExistingJob,false);const xml=renderJobXml(job);assert.match(xml,/<disabled>true<\/disabled>/);assert.match(xml,/<userid>gromesh-dev-runner<\/userid>/);assert.doesNotMatch(xml,/gromesh-hml|gromesh-prd|cluster-admin/);}
});
