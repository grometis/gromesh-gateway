import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { referenceJobDefinition,renderJobXml } from './jobs.mjs';
test('digest PR job is disabled and separated from publisher/CD identities; local CLI cannot use host credentials',()=>{
 const xml=renderJobXml(referenceJobDefinition('a'.repeat(40)));assert.match(xml,/<userid>gromesh-delivery-runner<\/userid>/);assert.match(xml,/<disabled>true<\/disabled>/);assert.match(xml,/Jenkinsfile.references/);
 const r=spawnSync(process.execPath,['ci/jenkins/reference-pipeline.mjs'],{env:{PATH:process.env.PATH},encoding:'utf8'});assert.equal(r.status,78);assert.match(r.stdout,/NOT_CONFIGURED/);
});
