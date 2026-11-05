import { readFile,writeFile } from 'node:fs/promises';
import { createPrivateKey,createPublicKey } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { mergeNativeArchives,readOciArchive } from './oci-archive.mjs';
import { byteDigest } from './registry.mjs';
import { canonicalHash,isSha } from './policy.mjs';
import { verifyPublishableCi,verifyEnvelope,signEnvelope,validatePublication } from './release.mjs';
import { runtimeConfig,privateCredential } from './protected.mjs';
import { imageWorkspace } from './workspaces.mjs';
const components=['control-plane','ui','agent','kong'],refuse=reason=>{throw new Error(`Bundle refused: ${reason}`);};
const json=async path=>JSON.parse(await readFile(path,'utf8'));
export async function inspectBundle(request,directory,trusted){
 verifyPublishableCi(request,trusted);
 const proofs={};
 for(const envelope of request.artifacts??[]){
  const a=verifyEnvelope(envelope,{...trusted.artifactKey,purpose:'artifact'});
  if(!components.includes(a.component))refuse('component');
  const oci=await readOciArchive(`${directory}/${a.component}.oci.tar`,{sha:trusted.expected.source.sha,platforms:['linux/amd64','linux/arm64']});
  const sbomBytes=await readFile(`${directory}/${a.component}.sbom-index.json`),sbom=JSON.parse(sbomBytes);
  if(sbom.subject!==oci.proof.digest||sbom.documents?.length!==2||new Set(sbom.documents.map(d=>d.architecture)).size!==2)refuse('SBOM subject/platform matrix');
  for(const doc of sbom.documents){
   if(!['amd64','arm64'].includes(doc.architecture))refuse('native SBOM platform');
   const source=await readFile(`${directory}/${a.component}-${doc.architecture}.spdx.json`);
   const scan=await readFile(`${directory}/${a.component}-${doc.architecture}.trivy.json`),report=JSON.parse(scan);
   if(byteDigest(source)!==doc.sbomHash||byteDigest(scan)!==doc.scanHash||!oci.proof.images.some(i=>i.platform==='linux/'+doc.architecture&&i.digest===doc.imageDigest)
    ||report.SchemaVersion!==2||!Array.isArray(report.Results)||report.Results.some(r=>r.Vulnerabilities?.some(v=>v.Severity==='CRITICAL')))refuse('actual SBOM/scan/image bytes');
  }
  proofs[a.component]={...a.proof,indexDigest:oci.proof.digest,archiveHash:oci.archiveHash,verifiedGraph:oci.proof.verifiedGraph,sbomHash:byteDigest(sbomBytes),sbomSubject:sbom.subject};
 }
 const release=validatePublication(request,{...trusted,artifactProofs:proofs});return {release,proofs};
}
async function main(){
 const config=await runtimeConfig('images.json','image-coordinator');
 const directory=await imageWorkspace(process.env.BUILD_NUMBER);
 if(config.artifactTransport?.qualified!==true)refuse('qualified artifact storage/transport capacity');
 const ci=await json(directory+'/ci-attestation.json'),context=await json(directory+'/ci-context.json');
 const trusted={...context,now:Date.now(),nativeWorkers:config.nativeWorkers,registry:config.registry,ciKey:{publicKey:createPublicKey(config.ciPublicKey),keyId:config.ciKeyId},artifactKey:{publicKey:createPublicKey(config.artifactPublicKey),keyId:config.artifactKeyId}};
 verifyPublishableCi({ci},trusted);
 if(process.argv[2]==='verify-ci'){console.log(JSON.stringify({status:'EXACT_COMPLETE_CI_VERIFIED'}));return;}
 if(process.argv[2]!=='assemble')refuse('operation');
 const privateKey=createPrivateKey(await privateCredential(process.env.GROMESH_ARTIFACT_SIGNING_KEY_FILE));
 const artifacts=[];
 for(const component of components){
  const records=[];
  for(const arch of ['amd64','arm64']){
   const r=await json(`${directory}/${component}-${arch}.result.json`),native=await readOciArchive(`${directory}/${component}-${arch}.oci.tar`,{sha:context.expected.source.sha,platforms:['linux/'+arch]});
   if(r.component!==component||r.platform!=='linux/'+arch||r.sourceSha!==context.expected.source.sha||r.pipelineSha!==config.pipelineSha
     ||r.archiveHash!==native.archiveHash||r.indexDigest!==native.proof.digest||r.toolchainVerified!==true||r.scanStatus!=='PASS'||r.critical!==0
     ||r.build?.job!=='gromesh-artifacts/gromesh-images'||r.build.id!==process.env.BUILD_NUMBER||r.build.url!==process.env.BUILD_URL||r.build.pipelineSha!==config.pipelineSha||r.workerId!==config.nativeWorkers?.[arch]
     ||!Array.isArray(r.reports)||r.reports.length!==(component==='kong'?8:3)||!['build','sbom','scan'].every(p=>r.reports.some(s=>s.phase===p))||r.reports.some(s=>s.status!=='SUCCESS'||s.exitCode!==0)
     ||(component==='kong'&&r.kongTestsPassed!==true))refuse('native build provenance/results');
   records.push({...r,architecture:arch,imageDigest:native.proof.images[0].digest});
  }
  const merged=await mergeNativeArchives([directory+'/'+component+'-amd64.oci.tar',directory+'/'+component+'-arm64.oci.tar'],directory+'/'+component+'.oci.tar',{sha:context.expected.source.sha});
  const sbom={schema:'gromesh-sbom-index/v1',subject:merged.proof.digest,documents:records.map(r=>({architecture:r.architecture,imageDigest:r.imageDigest,sbomHash:r.sbomHash,scanHash:r.scanHash}))};
  const sbomBytes=Buffer.from(JSON.stringify(sbom,null,2)+'\n');await writeFile(directory+'/'+component+'.sbom-index.json',sbomBytes,{mode:0o600});
  const proof={indexDigest:merged.proof.digest,archiveHash:merged.archiveHash,sbomHash:byteDigest(sbomBytes),sbomSubject:merged.proof.digest,scannedDigest:merged.proof.digest,verifiedGraph:true,nativePlatformsVerified:true,kongTestsPassed:component==='kong',toolchainVerified:true,scanStatus:'PASS',critical:0};
  const timestamp=Date.now();
  artifacts.push(signEnvelope({schema:'gromesh-image-attestation/v1',component,producer:context.imageBuild,nativeProducers:records.map(r=>({platform:r.platform,build:r.build,workerId:r.workerId})),sourceSha:context.expected.source.sha,pipelineSha:config.pipelineSha,ciHash:canonicalHash(ci),indexDigest:merged.proof.digest,archiveHash:merged.archiveHash,sbomHash:proof.sbomHash,platforms:['linux/amd64','linux/arm64'],proof,
   issuedAt:new Date(timestamp).toISOString(),expiresAt:new Date(timestamp+24*3600000).toISOString()},{privateKey,keyId:config.artifactKeyId,purpose:'artifact'}));
 }
 const request={ci,artifacts};await inspectBundle(request,directory,trusted);
 await writeFile(directory+'/release-request.json',JSON.stringify(request,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({status:'SIGNED_IMAGE_BUNDLE_NOT_PUBLISHED',components}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.log(JSON.stringify({status:'IMAGE_BUNDLE_NOT_CONFIGURED_OR_REFUSED'}));process.exitCode=78;});
