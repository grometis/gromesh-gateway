import {createHash} from 'node:crypto';
import {canonicalHash,isSha,isDigest,validateSource} from './policy.mjs';
const refuse=()=>{throw new Error('Artifact refused: identity, scope, size, retention or integrity');};
const safeKey=k=>typeof k==='string'&&k.length<=512&&/^[a-zA-Z0-9][a-zA-Z0-9/._-]+$/.test(k)&&!k.split('/').some(p=>!p||p==='.'||p==='..');
export function artifactStoragePlan(p){
 if(!p||!safeKey(p.prefix+'sentinel')||!p.prefix.endsWith('/')||p.maximumObjectGiB!==20||!Number.isSafeInteger(p.retainedRuns)||p.retainedRuns<1||p.retainedRuns>10)refuse();
 return {provider:'artifact-manager-s3',enabled:false,qualified:false,prefix:p.prefix,maximumObjectBytes:20*2**30,retainedRuns:p.retainedRuns,consoleLogsOffloaded:false,backendQuotaEnforced:false,blockers:['BACKEND_AUTHORIZATION','STORAGE_CREDENTIAL_SEPARATE','PLUGIN_INSTALL_REVIEW','TLS_IAM_PRESIGNED_URL_REVIEW','HARD_QUOTA_AND_RETENTION','RESTORE','REAL_JENKINS_ARCHIVE_STASH_COPYARTIFACT']};
}
export function validateArtifactManifest(m,c){
 try{validateSource(c?.source);validateSource(m?.source);}catch{refuse();}
 const start=Date.parse(m?.createdAt),end=Date.parse(m?.expiresAt);
 if(m?.schema!=='gromesh-stored-artifact/v1'||!isSha(c?.pipelineSha)||m.pipelineSha!==c.pipelineSha||canonicalHash(m.source)!==canonicalHash(c.source)
  ||!/^gromesh-artifacts\/gromesh-images$/.test(c.job??'')||m.job!==c.job||!/^\d*[1-9]\d*$/.test(c.buildId??'')||m.buildId!==c.buildId
  ||!safeKey(m.key)||!safeKey(c.prefix+'sentinel')||!c.prefix.endsWith('/')||!m.key.startsWith(`${c.prefix}${m.pipelineSha}/${m.source.sha}/${m.buildId}/`)
  ||!Array.isArray(c.allowedConsumers)||!['publisher','image-coordinator','reference-coordinator'].includes(c.consumer)||!c.allowedConsumers.includes(c.consumer)
  ||!Number.isSafeInteger(m.bytes)||m.bytes<1||!Number.isSafeInteger(c.maximumBytes)||c.maximumBytes<1||c.maximumBytes>20*2**30||m.bytes>c.maximumBytes
  ||!Number.isSafeInteger(c.quotaBytes)||!Number.isSafeInteger(c.usedBytes)||c.usedBytes<0||c.quotaBytes<1||m.bytes>c.quotaBytes-c.usedBytes
  ||!isDigest(m.digest)||m.retentionClass!=='scratch'||!Number.isFinite(c.now)||!Number.isFinite(start)||!Number.isFinite(end)||start>c.now||end<=c.now||end<=start
  ||!Number.isSafeInteger(c.maximumRetentionMs)||c.maximumRetentionMs<1||end-start>c.maximumRetentionMs)refuse();
 return {identity:canonicalHash(m),bytes:m.bytes,qualified:false};
}
export function verifyStoredBytes(m,bytes){
 if(!Buffer.isBuffer(bytes)||!Number.isSafeInteger(m?.bytes)||m.bytes<1||bytes.length!==m.bytes||m.bytes>20*2**30||!isDigest(m.digest)||'sha256:'+createHash('sha256').update(bytes).digest('hex')!==m.digest)refuse();
 return {verified:true,bytes:bytes.length,digest:m.digest,qualified:false};
}
