import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlan,applyPlan,createRollbackPlan } from './cd.mjs';
import { generateKeyPairSync } from 'node:crypto';
import { signEnvelope } from './release.mjs';
import { planDigest } from './approval.mjs';
import { readFileSync } from 'node:fs';
import { canonicalHash } from './policy.mjs';
test('APPLY always refuses this round before invoking any executor, including a forged enable parameter',async()=>{
 let writes=0;await assert.rejects(applyPlan({applyEnabled:true},null,{applyEnabled:true,execute:()=>writes++}),/not authorized|disabled/i);assert.equal(writes,0);
});
function input(){
 const {privateKey,publicKey}=generateKeyPairSync('ed25519'),digest='sha256:'+'a'.repeat(64);
 const releaseEnvelope=signEnvelope({schema:'gromesh-release/v1',official:true,registry:'docker.io/fabriciobackend',source:{repository:'grometis/gromesh-gateway',sha:'a'.repeat(40)},pipelineSha:'b'.repeat(40),artifacts:[{component:'ui',indexDigest:digest}]},{privateKey,keyId:'fixture-only',purpose:'release'});
 const target={environment:'DEV',component:'ui',release:'cp',namespace:'dev',kubeContext:'lab',deployment:'cp-control-plane-ui',container:'ui',expectedUid:'uid',expectedCaSha256:'c'.repeat(64),expectedCluster:'lab'};
 const scopedPlan={mode:'plan',release:'cp',namespace:'dev',context:'lab',cluster:{uid:'uid',caSha256:'c'.repeat(64),name:'lab'},changes:[{name:target.deployment,namespace:'dev',path:'.spec.template.spec.containers[name=ui].image',before:'repo@sha256:'+'b'.repeat(64),after:'docker.io/fabriciobackend/gromesh-ui@'+digest}],renderProof:{chartSha256:'d'.repeat(64),manifestSha256:'e'.repeat(64)},liveObjects:[{kind:'Deployment',uid:'ui-uid'}]};
 return {component:'ui',releaseEnvelope,releaseKey:{publicKey,keyId:'fixture-only'},target,scopedPlan,migrations:{status:'UNKNOWN_LIVE_SCHEMA',liveSchemaVerified:false,journalHash:'f'.repeat(64)},context:{requester:'operator',job:'gromesh-gateway/gromesh-dev/gromesh-dev',buildId:'10',now:Date.now()}};
}
test('unknown schema/backup/compatibility produce an explicit blocked PLAN with a bound hash',()=>{
 const p=createPlan(input());assert.equal(p.applyEnabled,false);assert.equal(p.eligibleForFutureApproval,false);assert.equal(p.blockers.length,5);assert.equal(planDigest(p),p.planHash);
 p.changes[0].after+='changed';assert.throws(()=>planDigest(p));
});
for(const [name,change] of [['another CA',x=>x.target.expectedCaSha256='0'.repeat(64)],['another namespace',x=>x.target.namespace='prod'],['another UI digest',x=>x.scopedPlan.changes[0].after='repo@sha256:'+'9'.repeat(64)],['unapproved requester',x=>x.context.requester='']])test(`PLAN refuses ${name}`,()=>{const x=input();change(x);assert.throws(()=>createPlan(x));});
test('control-plane and unknown live schema cannot produce an eligible image-only plan',()=>{
 assert.throws(()=>createPlan({component:'control-plane'}),/UI|scope/i);
 assert.throws(()=>createRollbackPlan({schemaCompatible:false}),/compatibility|schema/i);
});
function otherwiseEligible(){
 const x=input(),digest=x.releaseEnvelope.payload.artifacts[0].indexDigest;
 x.migrations={status:'NO_PENDING_MIGRATIONS',liveSchemaVerified:true,journalHash:'f'.repeat(64)};
 x.unchangedCpImage='repo@sha256:'+'c'.repeat(64);x.compatibility={tested:true,uiDigest:digest,cpImage:x.unchangedCpImage,schemaJournalHash:x.migrations.journalHash};
 x.backup={verified:true,digest:'sha256:'+'d'.repeat(64)};x.rollbackImageAvailable=true;return x;
}
test('removed or unproved target image cannot produce an eligible PLAN; proof is exact, fresh and hash bound',()=>{
 const x=otherwiseEligible();assert.equal(createPlan(x).eligibleForFutureApproval,false);
 x.targetImageProof={reference:x.scopedPlan.changes[0].after,available:true,method:'ANONYMOUS_FULL_PULL',observedAt:new Date(x.context.now).toISOString()};
 const p=createPlan(x);assert.equal(p.eligibleForFutureApproval,true);assert.equal(p.targetImageProof.reference,x.scopedPlan.changes[0].after);
 for(const alter of [p=>p.reference+='bad',p=>p.available=false,p=>p.observedAt=new Date(x.context.now-61000).toISOString()]){const q=structuredClone(x);alter(q.targetImageProof);assert.equal(createPlan(q).eligibleForFutureApproval,false);}
 p.targetImageProof.reference+='bad';assert.throws(()=>planDigest(p));
});
test('rollback requires the exact prior release and current live image and binds both plan hashes into the receipt',()=>{
 const x=otherwiseEligible();x.operation='ROLLBACK_PLAN';x.targetImageProof={reference:x.scopedPlan.changes[0].after,available:true,method:'ANONYMOUS_FULL_PULL',observedAt:new Date(x.context.now).toISOString()};
 assert.throws(()=>createPlan(x),/rollback/i);
 x.rollbackProof={historyVerified:true,schemaCompatible:true,previousImageAvailable:true,backupVerified:true,previousDigest:x.releaseEnvelope.payload.artifacts[0].indexDigest,currentDigest:'sha256:'+'b'.repeat(64),previousPlanHash:'1'.repeat(64),currentPlanHash:'2'.repeat(64)};
 x.rollbackProof.previousReleaseHash=canonicalHash(x.releaseEnvelope);
 const p=createPlan(x);assert.equal(p.rollbackRequest.previousPlanHash,'1'.repeat(64));assert.equal(p.rollbackRequest.currentDigest,x.rollbackProof.currentDigest);
 for(const alter of [p=>p.previousDigest='sha256:'+'9'.repeat(64),p=>p.currentDigest='sha256:'+'9'.repeat(64),p=>p.previousReleaseHash='9'.repeat(64)]){const q=structuredClone(x);alter(q.rollbackProof);assert.throws(()=>createPlan(q),/rollback/i);}
 p.rollbackRequest.currentPlanHash='9'.repeat(64);assert.throws(()=>planDigest(p));
});
test('service ACL preparation grants allocation only to matching agents and read-only access to required producer artifacts',()=>{
 const p=JSON.parse(readFileSync(new URL('./controller-rbac.json',import.meta.url)));
 for(const id of ['gromesh-ci-runner','gromesh-release-runner','gromesh-dev-runner'])assert.ok(p.agentGrants.some(g=>g.principal===id&&g.permissions.includes('Agent/Build')));
 assert.ok(p.producerReadGrants.some(g=>g.principal==='gromesh-release-runner'&&g.job==='gromesh-gateway/gromesh-ci/gromesh-main'));
 assert.ok(p.producerReadGrants.some(g=>g.principal==='gromesh-dev-runner'&&g.job==='gromesh-artifacts/gromesh-images'));
 assert.ok(p.producerReadGrants.every(g=>g.credentialsVisible===false&&!g.permissions.includes('Job/Build')));
});
