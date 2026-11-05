import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCutover,rollbackTransitionPlan,workflowCoverage } from './transition.mjs';
import { requiredStages,canonicalHash } from './policy.mjs';
import { generateKeyPairSync } from 'node:crypto';
import { signEnvelope } from './release.mjs';
import { checkIdentity } from './final-status.mjs';
test('absent real CI, checks, candidate publication, reviews and cutover authorization always blocks transition',()=>{
 const r=assessCutover({}, {now:Date.now(),pipelineSha:'a'.repeat(40)});
 assert.equal(r.ready,false);assert.ok(r.blockers.length>=6);assert.equal(r.performsWrites,false);
});
test('every original workflow has an explicit replacement and rollback restores protection before Actions publishing',()=>{
 assert.deepEqual(Object.keys(workflowCoverage).sort(),['ci.yml','image-digests.yml','images.yml','kong-image-build.yml','kong-image-candidate.yml','kong-image.yml'].sort());
 const p=rollbackTransitionPlan({rulesetId:25344054,requiredCheck:'ci-ok',actionsWorkflowFiles:Object.keys(workflowCoverage)});
 assert.equal(p.automatic,false);assert.equal(p.requiresHumanAuthorization,true);
 assert.ok(p.steps[0].includes('Jenkins'));assert.ok(p.steps.findIndex(x=>x.includes('ci-ok'))<p.steps.findIndex(x=>x.includes('reativar')));
 assert.throws(()=>rollbackTransitionPlan({rulesetId:25344054,requiredCheck:'jenkins-ci-pr'}));
});
function fixture(){
 const pipelineSha='a'.repeat(40),now=Date.now(),{privateKey,publicKey}=generateKeyPairSync('ed25519');
 const ciRuns=['push','pull_request'].map((event,i)=>{
  const job='gromesh-gateway/gromesh-ci/gromesh-'+(i?'prs':'main'),id=String(i+1),sha=(i?'c':'b').repeat(40);
  const source={repository:'grometis/gromesh-gateway',sha,event,branch:i?'test/pr':'main',pr:i?1:null,baseSha:i?'b'.repeat(40):null,...(i?{headSha:'d'.repeat(40)}:{})};
  const build={job,id,url:'https://jenkins.grometis.com'+job.split('/').map(p=>'/job/'+p).join('')+'/'+id+'/'};
  const report={schema:'gromesh-jenkins-ci/v1',source,pipelineSha,build,tools:{node:'v26.13.0',pnpm:'10.28.0',go:'go1.27.3'},stages:requiredStages.map(id=>({id,status:'SUCCESS',exitCode:0,durationMs:1,complete:true,tests:{known:true,passed:1,failed:0,skipped:0},artifacts:[{path:'stdout.log',kind:'log',bytes:1,sha256:'1'.repeat(64)},{path:'stderr.log',kind:'log',bytes:0,sha256:'2'.repeat(64)},...(id==='ui-acceptance'?[{path:'screenshots/ui.png',kind:'screenshot',bytes:1,sha256:'3'.repeat(64)}]:[])],...(id==='image-scan'?{platforms:['linux/amd64','linux/arm64']}:{})}))};
  const identity=checkIdentity({source,pipelineSha,build});
  return {report,run:{job,id,building:false,result:'SUCCESS',pipelineSha,sourceSha:identity.sha,completedAt:new Date(now-1000).toISOString()},check:{app:{id:12},status:'completed',conclusion:'success',name:identity.name,head_sha:identity.sha,external_id:identity.externalId,details_url:identity.url}};
 });
 const release={schema:'gromesh-candidate-release/v1',official:false,pipelineSha,source:ciRuns[0].report.source,ci:ciRuns[0].report.build,artifacts:['control-plane','ui','agent','kong'].map((component,i)=>({component,indexDigest:'sha256:'+String(i+1).repeat(64),platforms:['linux/amd64','linux/arm64']}))};
 const candidateEnvelope=signEnvelope(release,{privateKey,keyId:'fixture-only',purpose:'release'});
 const evidence={actions:{allActive:true},ruleset:{id:25344054,enforcement:'active',requiredChecks:['ci-ok']},ciRuns,candidateEnvelope,
  hubReadbacks:release.artifacts.map(a=>({component:a.component,digest:a.indexDigest,anonymousFullPull:'SUCCESS',signatureVerified:true,sbomVerified:true,scannedDigest:a.indexDigest,critical:0})),
  coverage:Object.fromEntries(Object.keys(workflowCoverage).map(file=>[file,{tested:true,pipelineSha,evidenceSha256:'1'.repeat(64)}])),review:{pipelineSha,accepted:true,openCritical:0,openImportant:0,evidenceSha256:'2'.repeat(64)},authorization:{pipelineSha,candidateHash:canonicalHash(candidateEnvelope),authorizedBy:'owner',explicitCutover:true},jenkins:{rbacQualified:true,recoveryQualified:true,workersQualified:true}};
 return {evidence,trusted:{now,pipelineSha,appId:12,releaseKey:{publicKey,keyId:'fixture-only'},cutoverApprover:'owner'}};
}
test('complete synthetic evidence can pass assessment but missing/altered checks, registry bytes, coverage or gates cannot',()=>{
 const f=fixture();assert.deepEqual(assessCutover(f.evidence,f.trusted).blockers,[]);
 for(const change of [x=>x.ciRuns[1].report.stages.pop(),x=>x.ciRuns[1].check.app.id=99,x=>x.ciRuns[1].check.name='jenkins-ci-branch',x=>x.ciRuns[0].run.result='FAILURE',x=>x.candidateEnvelope.payload.official=true,x=>x.hubReadbacks[0].digest='sha256:'+'9'.repeat(64),x=>x.hubReadbacks.pop(),x=>x.coverage['image-digests.yml'].tested=false,x=>x.review.openImportant=1,x=>x.authorization.explicitCutover=false,x=>x.actions.allActive=false,x=>x.ruleset.requiredChecks=[],x=>x.jenkins.workersQualified=false]){
  const evidence=structuredClone(f.evidence);change(evidence);assert.equal(assessCutover(evidence,f.trusted).ready,false);
 }
});
