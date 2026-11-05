import { sign,verify } from 'node:crypto';
import { canonicalJson,canonicalHash,assertPublishable,isDigest } from './policy.mjs';
import { assertOfficialCutover } from './actions-state.mjs';
const refuse=reason=>{throw new Error(`Release refused: ${reason}`);};
export function signEnvelope(payload,{privateKey,keyId,purpose}){
 if(!/^[a-z0-9-]{1,80}$/.test(keyId)||!['ci','artifact','release','approval'].includes(purpose))refuse('envelope identity');
 const body={schema:'gromesh-signed/v1',keyId,purpose,payload};
 return {...body,signature:sign(null,Buffer.from(canonicalJson(body)),privateKey).toString('base64')};
}
export function verifyEnvelope(envelope,{publicKey,keyId,purpose}){
 if(!envelope||envelope.schema!=='gromesh-signed/v1'||envelope.keyId!==keyId||envelope.purpose!==purpose
   ||typeof envelope.signature!=='string'||!envelope.payload)refuse('signed envelope identity/signature');
 const {signature,...body}=envelope;
 if(!/^[A-Za-z0-9+/]{86}==$/.test(signature)||!verify(null,Buffer.from(canonicalJson(body)),publicKey,Buffer.from(signature,'base64')))refuse('signature');
 return envelope.payload;
}
export function assertDeployableRelease(release){
 if(release?.schema!=='gromesh-release/v1'||release.official!==true||release.registry!=='docker.io/fabriciobackend')refuse('official release required; candidate cannot enter DEV');
 return release;
}
function timeWindow(value,now){
 const start=Date.parse(value.issuedAt),end=Date.parse(value.expiresAt);
 if(!Number.isFinite(now)||!Number.isFinite(start)||!Number.isFinite(end)||start>now+30000||end<=now||end-start>24*3600*1000||end<=start)refuse('attestation time window');
}
export function verifyPublishableCi(request,trusted){
 const ci=verifyEnvelope(request.ci,{...trusted.ciKey,purpose:'ci'});timeWindow(ci,trusted.now);
 if(ci.schema!=='gromesh-ci-attestation/v1')refuse('CI attestation schema');
 assertPublishable(trusted.expected.source,ci.report,trusted.expected);
 // This metadata comes from Jenkins Run objects, never the uploaded artifact.
 const live=trusted.latestCi;
 if(!live||live.building!==false||live.result!=='SUCCESS'||live.id!==ci.report.build.id||live.job!==ci.report.build.job
   ||live.latestAttemptId!==live.id||live.sourceSha!==ci.report.source.sha||live.pipelineSha!==ci.report.pipelineSha)refuse('latest completed CI run');
 return ci;
}
export function validatePublication(request,trusted){
 const ci=verifyPublishableCi(request,trusted);
 const producer=trusted.imageBuild;
 if(producer?.job!=='gromesh-artifacts/gromesh-images'||!/^[1-9][0-9]*$/.test(producer.id??'')||producer.pipelineSha!==trusted.expected.pipelineSha
  ||producer.url!==`https://jenkins.grometis.com/job/gromesh-artifacts/job/gromesh-images/${producer.id}/`)refuse('trusted image-producing build');
 if(!['amd64','arm64'].every(a=>/^[a-z0-9-]{3,100}$/.test(trusted.nativeWorkers?.[a]??'')&&!/n2|docker-desktop/.test(trusted.nativeWorkers[a]))||trusted.nativeWorkers.amd64===trusted.nativeWorkers.arm64)refuse('qualified native worker identities');
 const components=['control-plane','ui','agent','kong'];
 if(!Array.isArray(request.artifacts)||request.artifacts.length!==components.length)refuse('complete product image set');
 const seen=new Set();const artifacts=[];
 for(const envelope of request.artifacts){
  const a=verifyEnvelope(envelope,{...trusted.artifactKey,purpose:'artifact'});timeWindow(a,trusted.now);
  if(a.schema!=='gromesh-image-attestation/v1'||!components.includes(a.component)||seen.has(a.component)
    ||a.sourceSha!==ci.report.source.sha||a.pipelineSha!==ci.report.pipelineSha||a.ciHash!==canonicalHash(request.ci)
    ||!isDigest(a.indexDigest)||canonicalJson([...(a.platforms??[])].sort())!==canonicalJson(['linux/amd64','linux/arm64']))refuse('artifact identity');
  if(canonicalHash(a.producer)!==canonicalHash(producer)||!Array.isArray(a.nativeProducers)||a.nativeProducers.length!==2
   ||new Set(a.nativeProducers.map(p=>p.platform)).size!==2||a.nativeProducers.some(p=>!['linux/amd64','linux/arm64'].includes(p.platform)
     ||canonicalHash(p.build)!==canonicalHash(producer)||p.workerId!==trusted.nativeWorkers?.[p.platform.slice(6)]))refuse('image producer/native build identity');
  const proof=trusted.artifactProofs?.[a.component];
  if(!proof||proof.indexDigest!==a.indexDigest||proof.archiveHash!==a.archiveHash||!isDigest(a.archiveHash)
    ||proof.verifiedGraph!==true||proof.scannedDigest!==a.indexDigest||proof.scanStatus!=='PASS'||proof.critical!==0
    ||!isDigest(proof.sbomHash)||proof.sbomHash!==a.sbomHash||proof.sbomSubject!==a.indexDigest
    ||proof.nativePlatformsVerified!==true||proof.kongTestsPassed!==(a.component==='kong')
    ||proof.toolchainVerified!==true)refuse('verified OCI bytes, native builds, SBOM and scan required');
  seen.add(a.component);artifacts.push(a);
 }
 const registry=trusted.registry,official=registry?.publicationClass==='OFFICIAL';
 if(registry?.namespace!=='fabriciobackend'||registry.visibility!=='public'||registry.writerScoped!==true||registry.immutableTagsVerified!==true
   ||!(official?registry.publisherMode==='JENKINS_ONLY':registry.publicationClass==='CANDIDATE'&&registry.publisherMode==='ACTIONS_OFFICIAL_JENKINS_CANDIDATE'))refuse('registry authorization/cutover');
 if(official)assertOfficialCutover({cutover:registry.cutover,state:trusted.publisherState,pipelineSha:trusted.expected.pipelineSha,now:trusted.now});
 return {schema:official?'gromesh-release/v1':'gromesh-candidate-release/v1',official,source:ci.report.source,pipelineSha:ci.report.pipelineSha,ci:ci.report.build,producer,ciHash:canonicalHash(request.ci),artifacts,
   issuedAt:new Date(trusted.now).toISOString(),registry:'docker.io/fabriciobackend'};
}
