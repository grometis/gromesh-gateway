import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { requiredStages,canonicalHash } from './policy.mjs';
import { byteDigest } from './registry.mjs';
import { signEnvelope } from './release.mjs';
import { mergeNativeArchives } from './oci-archive.mjs';
import { inspectBundle } from './bundle.mjs';
import { publishVerifiedBundle } from './publisher.mjs';
const exec=promisify(execFile),sha='a'.repeat(40),pipelineSha='b'.repeat(40);
async function fixture(root){
 const {privateKey,publicKey}=generateKeyPairSync('ed25519'),now=Date.now();
 const source={repository:'grometis/gromesh-gateway',sha,event:'push',branch:'main',pr:null,baseSha:null},job='gromesh-gateway/gromesh-ci/gromesh-main';
 const report={schema:'gromesh-jenkins-ci/v1',source,pipelineSha,build:{job,id:'17',url:'https://jenkins.grometis.com/job/gromesh-gateway/job/gromesh-ci/job/gromesh-main/17/'},tools:{node:'v26.13.0',pnpm:'10.28.0',go:'go1.27.3'},
  stages:requiredStages.map(id=>({id,status:'SUCCESS',exitCode:0,durationMs:10,complete:true,tests:{known:true,passed:1,failed:0,skipped:0},artifacts:[{path:'stdout.log',kind:'log',bytes:1,sha256:'a'.repeat(64)},{path:'stderr.log',kind:'log',bytes:0,sha256:'b'.repeat(64)},...(id==='ui-acceptance'?[{path:'screenshots/ui.png',kind:'screenshot',bytes:1,sha256:'c'.repeat(64)}]:[])],...(id==='image-scan'?{platforms:['linux/amd64','linux/arm64']}:{})}))};
 const window={issuedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60000).toISOString()},key={privateKey,keyId:'fixture-only'};
 const producer={job:'gromesh-artifacts/gromesh-images',id:'21',url:'https://jenkins.grometis.com/job/gromesh-artifacts/job/gromesh-images/21/',pipelineSha};
 const nativeWorkers={amd64:'gromesh-build-amd64',arm64:'gromesh-build-arm64'};
 const ci=signEnvelope({schema:'gromesh-ci-attestation/v1',report,...window},{...key,purpose:'ci'}),artifacts=[];
 for(const component of ['control-plane','ui','agent','kong']){
  const archives=[],documents=[];
  for(const arch of ['amd64','arm64']){
   const dir=join(root,component+'-'+arch);await mkdir(join(dir,'blobs/sha256'),{recursive:true});
   const add=async value=>{const b=Buffer.from(JSON.stringify(value)),digest=byteDigest(b);await writeFile(join(dir,'blobs/sha256',digest.slice(7)),b);return {digest,size:b.length};};
   const config=await add({architecture:arch,os:'linux',config:{Labels:{'org.opencontainers.image.revision':sha,'org.opencontainers.image.source':'https://github.com/grometis/gromesh-gateway'}}});
   const layer=await add({fixture:'non-executable layer'}),image=await add({schemaVersion:2,config,layers:[layer]});
   await writeFile(join(dir,'oci-layout'),'{"imageLayoutVersion":"1.0.0"}');await writeFile(join(dir,'index.json'),JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.index.v1+json',manifests:[{...image,mediaType:'application/vnd.oci.image.manifest.v1+json',platform:{architecture:arch,os:'linux'}}]}));
   const archive=dir+'.oci.tar';await exec('tar',['--format=ustar','-cf',archive,'-C',dir,'oci-layout','index.json','blobs']);archives.push(archive);
   const sbom=Buffer.from('{"spdxVersion":"SPDX-2.3","packages":[],"documentNamespace":"urn:fixture-only"}'),scan=Buffer.from('{"SchemaVersion":2,"Metadata":{},"Results":[]}');
   await writeFile(join(root,`${component}-${arch}.spdx.json`),sbom);await writeFile(join(root,`${component}-${arch}.trivy.json`),scan);
   documents.push({architecture:arch,imageDigest:image.digest,sbomHash:byteDigest(sbom),scanHash:byteDigest(scan)});
  }
  const merged=await mergeNativeArchives(archives,join(root,component+'.oci.tar'),{sha});
  const sbomBytes=Buffer.from(JSON.stringify({schema:'gromesh-sbom-index/v1',subject:merged.proof.digest,documents}));await writeFile(join(root,component+'.sbom-index.json'),sbomBytes);
  const proof={indexDigest:merged.proof.digest,archiveHash:merged.archiveHash,sbomHash:byteDigest(sbomBytes),sbomSubject:merged.proof.digest,scannedDigest:merged.proof.digest,verifiedGraph:true,nativePlatformsVerified:true,kongTestsPassed:component==='kong',toolchainVerified:true,scanStatus:'PASS',critical:0};
  artifacts.push(signEnvelope({schema:'gromesh-image-attestation/v1',component,producer,nativeProducers:['amd64','arm64'].map(a=>({platform:'linux/'+a,build:producer,workerId:nativeWorkers[a]})),sourceSha:sha,pipelineSha,ciHash:canonicalHash(ci),indexDigest:proof.indexDigest,archiveHash:proof.archiveHash,sbomHash:proof.sbomHash,platforms:['linux/amd64','linux/arm64'],proof,...window},{...key,purpose:'artifact'}));
 }
 return {request:{ci,artifacts},trusted:{now,imageBuild:producer,nativeWorkers,expected:{source,pipelineSha,job,buildId:'17'},latestCi:{building:false,result:'SUCCESS',id:'17',job,latestAttemptId:'17',sourceSha:sha,pipelineSha},registry:{namespace:'fabriciobackend',visibility:'public',writerScoped:true,immutableTagsVerified:true,publisherMode:'JENKINS_ONLY'},ciKey:{publicKey,keyId:'fixture-only'},artifactKey:{publicKey,keyId:'fixture-only'}}};
}
test('validates signed fixture evidence against actual tar/SBOM/scan bytes for all four products',async()=>{
 const root=await mkdtemp(join(tmpdir(),'j5-bundle-'));
 try{const f=await fixture(root);const valid=await inspectBundle(f.request,root,f.trusted);assert.equal(valid.release.artifacts.length,4);
  await writeFile(join(root,'ui-arm64.trivy.json'),'{"SchemaVersion":2,"Metadata":{},"Results":[{"Vulnerabilities":[{"Severity":"CRITICAL"}]}]}');
  let commands=0;await assert.rejects(publishVerifiedBundle(f.request,f.trusted,{directory:root,execute:async()=>commands++,lookup:async()=>commands++}),/bytes|scan/i);assert.equal(commands,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
