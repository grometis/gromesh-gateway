import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { signEnvelope,verifyEnvelope,validatePublication } from './release.mjs';
import { canonicalHash,requiredStages } from './policy.mjs';
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const subject={schema:'test/v1',sha:'a'.repeat(40),nested:{a:1}};
test('signed canonical envelopes verify actual Ed25519 signatures and enforce purpose/key',()=>{
 const e=signEnvelope(subject,{privateKey,keyId:'ci-2026',purpose:'ci'});
 assert.deepEqual(verifyEnvelope(e,{publicKey,keyId:'ci-2026',purpose:'ci'}),subject);
 for(const change of [x=>x.payload.nested.a++,x=>x.purpose='release',x=>x.keyId='another',x=>x.signature='AAAA']){const x=structuredClone(e);change(x);assert.throws(()=>verifyEnvelope(x,{publicKey,keyId:'ci-2026',purpose:'ci'}));}
});
test('publication refuses CI JSON without a valid signature before considering artifacts',()=>{
 assert.throws(()=>validatePublication({ci:{payload:subject},artifacts:[]},{ciKey:{publicKey,keyId:'ci-2026'},now:Date.now()}),/signature|envelope/i);
});
function publication(){
 const now=Date.now(),pipelineSha='b'.repeat(40),sha='a'.repeat(40),window={issuedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60000).toISOString()};
 const source={repository:'grometis/gromesh-gateway',sha,event:'push',branch:'main',pr:null,baseSha:null};
 const report={schema:'gromesh-jenkins-ci/v1',source,pipelineSha,build:{job:'gromesh-gateway/gromesh-ci/gromesh-main',id:'17',url:'https://jenkins.grometis.com/job/gromesh-gateway/job/gromesh-ci/job/gromesh-main/17/'},tools:{node:'v26.13.0',pnpm:'10.28.0',go:'go1.27.3'},stages:requiredStages.map(id=>({id,status:'SUCCESS',exitCode:0,durationMs:10,complete:true,tests:{known:true,passed:1,failed:0,skipped:0},artifacts:[{path:"stdout.log",kind:"log",bytes:12,sha256:"a".repeat(64)},{path:"stderr.log",kind:"log",bytes:0,sha256:"b".repeat(64)},...(id==="ui-acceptance"?[{path:"screenshots/ui.png",kind:"screenshot",bytes:12,sha256:"c".repeat(64)}]:[])],...(id==='image-scan'?{platforms:['linux/amd64','linux/arm64']}:{})}))};
 const producer={job:'gromesh-artifacts/gromesh-images',id:'21',url:'https://jenkins.grometis.com/job/gromesh-artifacts/job/gromesh-images/21/',pipelineSha};
 const nativeWorkers={amd64:'gromesh-build-amd64',arm64:'gromesh-build-arm64'};
 const ci=signEnvelope({schema:'gromesh-ci-attestation/v1',report,...window},{privateKey,keyId:'ci-2026',purpose:'ci'});
 const artifactProofs={},artifacts=['control-plane','ui','agent','kong'].map((component,i)=>{
  const d='sha256:'+String(i+1).repeat(64),archiveHash='sha256:'+'e'.repeat(64),sbomHash='sha256:'+'f'.repeat(64);
  artifactProofs[component]={indexDigest:d,archiveHash,sbomHash,sbomSubject:d,scannedDigest:d,scanStatus:'PASS',critical:0,verifiedGraph:true,nativePlatformsVerified:true,kongTestsPassed:component==='kong',toolchainVerified:true};
  return signEnvelope({schema:'gromesh-image-attestation/v1',component,producer,nativeProducers:['amd64','arm64'].map(a=>({platform:'linux/'+a,build:producer,workerId:nativeWorkers[a]})),sourceSha:sha,pipelineSha,ciHash:canonicalHash(ci),indexDigest:d,archiveHash,sbomHash,platforms:['linux/amd64','linux/arm64'],...window},{privateKey,keyId:'builder-2026',purpose:'artifact'});
 });
 return {request:{ci,artifacts},trusted:{now,imageBuild:producer,nativeWorkers,ciKey:{publicKey,keyId:'ci-2026'},artifactKey:{publicKey,keyId:'builder-2026'},expected:{source,pipelineSha,job:report.build.job,buildId:'17'},latestCi:{building:false,result:'SUCCESS',id:'17',job:report.build.job,latestAttemptId:'17',sourceSha:sha,pipelineSha},artifactProofs,registry:{namespace:'fabriciobackend',visibility:'public',writerScoped:true,immutableTagsVerified:true,publisherMode:'JENKINS_ONLY'}}};
}
test('a signed exact complete build with verified artifact bytes prepares an auditable release',()=>{
 const p=publication();const r=validatePublication(p.request,p.trusted);assert.equal(r.artifacts.length,4);assert.equal(r.source.sha,'a'.repeat(40));
});
for(const [name,change] of [
 ['a later CI attempt',p=>p.trusted.latestCi.latestAttemptId='18'],['a still-running CI job',p=>p.trusted.latestCi.building=true],['failed final CI',p=>p.trusted.latestCi.result='FAILURE'],
 ['missing Kong',p=>p.request.artifacts.pop()],['expired attestations',p=>p.trusted.now+=2*86400000],['unscanned bytes',p=>p.trusted.artifactProofs.ui.scannedDigest='sha256:'+'9'.repeat(64)],
 ['missing SBOM subject',p=>delete p.trusted.artifactProofs.ui.sbomSubject],['unverified native build',p=>p.trusted.artifactProofs.agent.nativePlatformsVerified=false],['mutable release tags',p=>p.trusted.registry.immutableTagsVerified=false],['another registry',p=>p.trusted.registry.namespace='elsewhere']
 ,['another image-producing build',p=>p.trusted.imageBuild={job:'gromesh-artifacts/gromesh-images',id:'99',url:'https://jenkins.grometis.com/job/gromesh-artifacts/job/gromesh-images/99/',pipelineSha:'b'.repeat(40)}]
])test(`publication refuses ${name}`,()=>{const p=publication();change(p);assert.throws(()=>validatePublication(p.request,p.trusted));});
