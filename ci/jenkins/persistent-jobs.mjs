import {createHash} from 'node:crypto';
import {isSha,canonicalHash} from './policy.mjs';
import {jobDefinitions,imageJobDefinition,referenceJobDefinition,renderJobXml} from './jobs.mjs';
const refuse=()=>{throw new Error('Persistent jobs refused: revision, inventory or preservation drift');};
export function persistentJobsManifest(pipelineSha,baselineSeedSha256){
 if(!isSha(pipelineSha)||!/^[a-f0-9]{64}$/.test(baselineSeedSha256??''))refuse();
 const jobs=[...jobDefinitions(pipelineSha),imageJobDefinition(pipelineSha),referenceJobDefinition(pipelineSha)].map(j=>{const xml=renderJobXml(j);return {...j,xml,sha256:createHash('sha256').update(xml).digest('hex')};});
 return {schema:'gromesh-persistent-jobs/v1',pipelineSha,baselineSeedSha256,activationEnabled:false,jobs};
}
export function assertPersistentJobPreflight(m,p){
 if(!m||canonicalHash(m)!==canonicalHash(persistentJobsManifest(m.pipelineSha,m.baselineSeedSha256))||m.baselineSeedSha256!==p?.baselineSeedSha256||p.currentSeedSha256!==p.baselineSeedSha256
  ||!Array.isArray(p.expectedExistingJobs)||!Array.isArray(p.currentExistingJobs)||canonicalHash([...p.expectedExistingJobs].sort())!==canonicalHash([...p.currentExistingJobs].sort())
  ||m.jobs.some(j=>p.currentExistingJobs.includes(j.name))||!/^[a-f0-9]{64}$/.test(p.beforeHistoryHash??'')||p.beforeHistoryHash!==p.currentHistoryHash||!/^[a-f0-9]{64}$/.test(p.beforeAclHash??'')||p.beforeAclHash!==p.currentAclHash)refuse();
 return true;
}
