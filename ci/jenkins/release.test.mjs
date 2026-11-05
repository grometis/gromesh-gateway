import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { signEnvelope,verifyEnvelope,validatePublication,assertDeployableRelease } from './release.mjs';
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
 return {request:{ci,artifacts},trusted:{now,imageBuild:producer,nativeWorkers,ciKey:{publicKey,keyId:'ci-2026'},artifactKey:{publicKey,keyId:'builder-2026'},expected:{source,pipelineSha,job:report.build.job,buildId:'17'},latestCi:{building:false,result:'SUCCESS',id:'17',job:report.build.job,latestAttemptId:'17',sourceSha:sha,pipelineSha},artifactProofs,registry:{namespace:'fabriciobackend',visibility:'public',writerScoped:true,immutableTagsVerified:true,publicationClass:'CANDIDATE',publisherMode:'ACTIONS_OFFICIAL_JENKINS_CANDIDATE'}}};
}
test('candidate releases are explicitly ineligible for deploy; official publication requires fresh disabled Actions plus cutover',()=>{
 const p=publication(),candidate=validatePublication(p.request,p.trusted);
 assert.equal(candidate.schema,'gromesh-candidate-release/v1');assert.equal(candidate.official,false);
 assert.throws(()=>assertDeployableRelease(candidate));
 const registry={...p.trusted.registry,publicationClass:'OFFICIAL',publisherMode:'JENKINS_ONLY'};
 assert.throws(()=>validatePublication(p.request,{...p.trusted,registry}));
 registry.cutover={approved:true,pipelineSha:p.trusted.expected.pipelineSha,authorizedBy:'owner',authorizedAt:new Date(p.trusted.now-1000).toISOString(),authorizationId:'J5-approved-cutover'};
 const publisherState={repository:'grometis/gromesh-gateway',observedAt:new Date(p.trusted.now).toISOString(),workflows:['images.yml','kong-image.yml','image-digests.yml'].map(file=>({file,state:'disabled_manually',activeRuns:0}))};
 assert.equal(validatePublication(p.request,{...p.trusted,registry,publisherState}).official,true);
 publisherState.workflows[0].state='active';assert.throws(()=>validatePublication(p.request,{...p.trusted,registry,publisherState}));
});
test('a signed exact complete build with verified artifact bytes prepares an auditable release',()=>{
 const p=publication();const r=validatePublication(p.request,p.trusted);assert.equal(r.artifacts.length,4);assert.equal(r.source.sha,'a'.repeat(40));
});
for(const [name,change] of [
 ['a later CI attempt',p=>p.trusted.latestCi.latestAttemptId='18'],['a still-running CI job',p=>p.trusted.latestCi.building=true],['failed final CI',p=>p.trusted.latestCi.result='FAILURE'],
 ['missing Kong',p=>p.request.artifacts.pop()],['expired attestations',p=>p.trusted.now+=2*86400000],['unscanned bytes',p=>p.trusted.artifactProofs.ui.scannedDigest='sha256:'+'9'.repeat(64)],
 ['missing SBOM subject',p=>delete p.trusted.artifactProofs.ui.sbomSubject],['unverified native build',p=>p.trusted.artifactProofs.agent.nativePlatformsVerified=false],['mutable release tags',p=>p.trusted.registry.immutableTagsVerified=false],['another registry',p=>p.trusted.registry.namespace='elsewhere']
 ,['another image-producing build',p=>p.trusted.imageBuild={job:'gromesh-artifacts/gromesh-images',id:'99',url:'https://jenkins.grometis.com/job/gromesh-artifacts/job/gromesh-images/99/',pipelineSha:'b'.repeat(40)}]
])test(`publication refuses ${name}`,()=>{const p=publication();change(p);assert.throws(()=>validatePublication(p.request,p.trusted));});

function ownerApprovedPat(p){
 p.trusted.registry={...p.trusted.registry,writerScoped:false,writerUsername:'fabriciobackend',writerAuthorization:{
  kind:'OWNER_APPROVED_PERSONAL_PAT',account:'fabriciobackend',credentialId:'gromesh-dockerhub-write-authfile',credentialFolder:'gromesh-artifacts',consumerJob:'gromesh-artifacts/gromesh-images',
  permission:'Repo Read & Write',expirationDays:90,delete:false,cloudSandboxes:false,accountWideReachAccepted:true,authorizationId:'J6-owner-pat-20261105',credentialBoundaryQualified:true,
  repositories:['fabriciobackend/gromesh-control-plane','fabriciobackend/gromesh-ui','fabriciobackend/gromesh-agent','fabriciobackend/gromesh-kong']}};
 return p;
}
test('owner-approved account PAT needs the qualified existing folder binding and never promotes a candidate to an official release',()=>{
 const p=ownerApprovedPat(publication()),r=validatePublication(p.request,p.trusted);
 assert.equal(r.official,false);assert.equal(r.artifacts.length,4);assert.throws(()=>assertDeployableRelease(r));
 p.trusted.registry.publicationClass='OFFICIAL';p.trusted.registry.publisherMode='JENKINS_ONLY';assert.throws(()=>validatePublication(p.request,p.trusted),/cutover/i);
});
for(const [name,change]of[
 ['unqualified binding',a=>a.credentialBoundaryQualified=false],['missing owner acceptance',a=>a.accountWideReachAccepted=false],
 ['another credential',a=>a.credentialId='another-project'],['another folder',a=>a.credentialFolder='gromesh-gateway'],['PR consumer',a=>a.consumerJob='gromesh-gateway/gromesh-ci/gromesh-prs'],
 ['another account',a=>a.account='elsewhere'],['delete permission',a=>a.delete=true],['Cloud Sandboxes',a=>a.cloudSandboxes=true],
 ['unapproved lifetime',a=>a.expirationDays=365],['missing authorization',a=>a.authorizationId=''],
 ['foreign repository',a=>a.repositories[3]='fabriciobackend/evolution-api'],['duplicate destination',a=>a.repositories[3]=a.repositories[0]]
])test(`personal PAT publication refuses ${name}`,()=>{
 const p=ownerApprovedPat(publication());change(p.trusted.registry.writerAuthorization);assert.throws(()=>validatePublication(p.request,p.trusted),/registry authorization/i);
});
test('owner approval of the PAT never overrides a failed final CI Run',()=>{const p=ownerApprovedPat(publication());p.trusted.latestCi.result='FAILURE';assert.throws(()=>validatePublication(p.request,p.trusted),/completed CI/i);});
