import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeBuildPlan,publicationPlan } from './images.mjs';
test('native builds have no publication credential and scan the exported bytes without rebuilding',()=>{
 const p=nativeBuildPlan({component:'ui',sha:'a'.repeat(40),architecture:'arm64',workerArchitecture:'arm64'});
 assert.equal(p.filter(c=>c.file==='docker').length,1);assert.ok(p[0].args.includes('--provenance=mode=max'));
 assert.equal(p[0].args.at(-1),'https://github.com/grometis/gromesh-gateway.git#'+'a'.repeat(40));assert.ok(p[0].args.includes('--tag'));
 assert.ok(p.some(c=>c.file==='syft'));assert.ok(p.some(c=>c.file==='trivy'));assert.doesNotMatch(JSON.stringify(p),/--push|password|token|authfile/);
});
test('cross architecture, arbitrary component and moving source builds are refused',()=>{
 for(const change of [{workerArchitecture:'amd64'},{component:'../../x'},{sha:'main'}])assert.throws(()=>nativeBuildPlan({component:'ui',sha:'a'.repeat(40),architecture:'arm64',workerArchitecture:'arm64',...change}));
});
test('publisher refuses replacing an existing SHA tag and requires a verified matching digest after push',()=>{
 const p={component:'ui',sha:'a'.repeat(40),archive:'/workspace/ui.oci.tar',authfile:'/run/secrets/hub.json',digest:'sha256:'+'a'.repeat(64),existingDigest:null};
 assert.ok(publicationPlan(p).some(c=>c.phase==='verify-anonymous-pull'));
 assert.throws(()=>publicationPlan({...p,existingDigest:'sha256:'+'b'.repeat(64)}));
 assert.equal(publicationPlan({...p,existingDigest:p.digest})[0].phase,'verify-anonymous-pull');
});
