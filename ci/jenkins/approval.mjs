import { canonicalHash,isSha } from './policy.mjs';
import { signEnvelope,verifyEnvelope } from './release.mjs';
export const J5_POLICY=Object.freeze({applyEnabled:false,hmlEnabled:false,prdEnabled:false,firstDevApplyAuthorized:false});
const refuse=reason=>{throw new Error(`Approval refused: ${reason}`);};
export function planDigest(plan){const {planHash,...payload}=plan;const actual=canonicalHash(payload);if(planHash!==undefined&&planHash!==actual)refuse('planHash changed');return actual;}
function validatePlan(plan){
 if(plan?.eligibleForFutureApproval===false||plan?.blockers?.length)refuse('blocked plan cannot be approved');
 if(plan?.schema!=='gromesh-cd-plan/v1'||!['DEV','HML','PRD'].includes(plan.environment)||!isSha(plan.sourceSha)
  ||!/^[a-f0-9]{64}$/.test(plan.releaseHash??'')||!/^[a-f0-9]{32}$/.test(plan.nonce??'')||!plan.requester
  ||!/^gromesh-gateway\/gromesh-(dev|hml|prd)\/gromesh-(dev|hml|prd|rollback)$/.test(plan.job??'')||!/^[1-9][0-9]*$/.test(plan.buildId??''))refuse('plan identity');
 if(!plan.job.startsWith('gromesh-gateway/gromesh-'+plan.environment.toLowerCase()+'/'))refuse('environment/job identity');
 const start=Date.parse(plan.issuedAt),end=Date.parse(plan.expiresAt);if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>30*60*1000)refuse('plan expiry');
}
export function createReceipt(plan,authenticated,policy,now){
 validatePlan(plan);
 if(!Number.isFinite(now)||now<Date.parse(plan.issuedAt)||now>=Date.parse(plan.expiresAt))refuse('approval time outside plan window');
 const ids=authenticated?.submitters;
 if(authenticated?.authentication!=='JENKINS_INPUT_SUBMITTER'||!Array.isArray(ids)||new Set(ids).size!==ids.length
  ||ids.length!==(plan.environment==='PRD'?2:1)||ids.some(id=>id===plan.requester||!policy.allowedApprovers?.includes(id)))refuse('authenticated independent quorum');
 return signEnvelope({schema:'gromesh-approval/v1',planHash:planDigest(plan),environment:plan.environment,job:plan.job,buildId:plan.buildId,nonce:plan.nonce,submitters:ids,issuedAt:new Date(now).toISOString(),expiresAt:plan.expiresAt},{...policy.signingKey,purpose:'approval'});
}
export function authorizePlan(plan,receipt,policy,{now,consumedNonces}){
 validatePlan(plan);const r=verifyEnvelope(receipt,{...policy.verificationKey,purpose:'approval'});
 if(r.schema!=='gromesh-approval/v1'||r.planHash!==planDigest(plan)||r.environment!==plan.environment||r.job!==plan.job||r.buildId!==plan.buildId||r.nonce!==plan.nonce||r.expiresAt!==plan.expiresAt
  ||!Array.isArray(r.submitters)||r.submitters.length!==(plan.environment==='PRD'?2:1)||new Set(r.submitters).size!==r.submitters.length||r.submitters.some(id=>id===plan.requester||!policy.allowedApprovers?.includes(id))
  ||!Number.isFinite(now)||now<Date.parse(plan.issuedAt)||now>=Date.parse(plan.expiresAt)||!Number.isFinite(Date.parse(r.issuedAt))||Date.parse(r.issuedAt)<Date.parse(plan.issuedAt)||Date.parse(r.issuedAt)>now||!(consumedNonces instanceof Set)||consumedNonces.has(plan.nonce))refuse('plan hash, identity, quorum, expiry or replay');
 return r;
}
