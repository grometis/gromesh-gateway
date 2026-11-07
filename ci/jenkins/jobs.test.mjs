import test from 'node:test';
import assert from 'node:assert/strict';
import { jobDefinitions,renderJobXml,assertScmActivation } from './jobs.mjs';
test('all prepared jobs stay disabled and pin the trusted pipeline separately from candidate SHA',()=>{
  const jobs=jobDefinitions('a'.repeat(40));
  assert.equal(jobs.length,4);
  for(const job of jobs){const xml=renderJobXml(job);assert.match(xml,/<disabled>true<\/disabled>/);assert.match(xml,/<name>a{40}<\/name>/);assert.doesNotMatch(xml,/credentialsId|localhost|scriptText/);}
});
test('job activation is blocked on the original controller without Git plugins/readback',()=>{
 assert.throws(()=>assertScmActivation({baseline:{},current:{},classes:[],dependencyMinimumsSatisfied:false}),/activation blocked/);
});
test('job generation refuses moving SCM references and foreign script paths',()=>{
  for(const sha of ['main','a'.repeat(7),'a'.repeat(39)+';'])assert.throws(()=>jobDefinitions(sha));
  const job=jobDefinitions('a'.repeat(40))[0];job.scriptPath='evil.groovy';assert.throws(()=>renderJobXml(job));
});
