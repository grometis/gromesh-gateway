import { readFile,lstat,realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash,randomBytes } from 'node:crypto';
import { canonicalHash,isSha,isDigest } from './policy.mjs';
import { verifyEnvelope,assertDeployableRelease } from './release.mjs';
import { J5_POLICY,authorizePlan } from './approval.mjs';
const refuse=reason=>{throw new Error(`CD refused: ${reason}`);};
export async function runGuardPlan(options,{guardPath,expectedSha256,execute}){
 return guardedRollout(options,{guardPath,expectedSha256,execute},'plan');
}
export async function runGuardApply(options,dependencies){
 if(!J5_POLICY.applyEnabled||!J5_POLICY.firstDevApplyAuthorized)refuse('APPLY disabled: no real deploy authorized in J5');
 return guardedRollout(options,dependencies,'apply');
}
async function guardedRollout(options,{guardPath,expectedSha256,execute},mode){
 if(guardPath!=='/opt/gromesh/guard/helm-scoped-rollout.mjs'||!/^[a-f0-9]{64}$/.test(expectedSha256??''))refuse('protected original guard required');
 const s=await lstat(guardPath),parent=await lstat('/opt/gromesh/guard');
 if(!s.isFile()||s.uid!==0||(s.mode&0o022)!==0||parent.uid!==0||(parent.mode&0o022)!==0||await realpath(guardPath)!==guardPath)refuse('immutable guard required');
 if(createHash('sha256').update(await readFile(guardPath)).digest('hex')!==expectedSha256)refuse('guard bytes changed');
 const {scopedRollout}=await import(pathToFileURL(guardPath));
 return scopedRollout({...options,mode,noHooks:true,authorizedHooks:[]},{...(execute?{execute}:{}),emit:()=>{}});
}
export function semanticScopedPlan(plan){
 const paths=[plan?.renderProof?.scope?.kubeconfig,plan?.renderProof?.chart].filter(p=>typeof p==='string'&&p.startsWith('/'));
 const visit=value=>{
  if(Array.isArray(value))return value.map(visit);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,visit(v)]));
  if(typeof value==='string'){
   if(value.startsWith('{'))try{return JSON.stringify(visit(JSON.parse(value)));}catch{}
   return paths.reduce((s,p,i)=>s.split(p).join(i===0?'{DEV_KUBECONFIG_FILE}':'{RELEASE_CHART_DIR}'),value);
  }
  return value;
 };return visit(plan);
}
export function createPlan(input){
 if(input.component!=='ui')refuse('original guard permits UI image scope only; CP/schema need a separate reviewed procedure');
 const {target,scopedPlan,migrations,compatibility,context}=input;
 const release=assertDeployableRelease(verifyEnvelope(input.releaseEnvelope,{...input.releaseKey,purpose:'release'}));
 const image=release.artifacts?.find(a=>a.component==='ui');
 if(release.schema!=='gromesh-release/v1'||!isSha(release.source?.sha)||!isDigest(image?.indexDigest))refuse('signed release');
 if(target?.environment!=='DEV'||target.component!=='ui'||target.deployment!==`${target.release}-control-plane-ui`||target.container!=='ui'
  ||scopedPlan?.mode!=='plan'||scopedPlan.namespace!==target.namespace||scopedPlan.release!==target.release||scopedPlan.context!==target.kubeContext
  ||scopedPlan.cluster?.uid!==target.expectedUid||scopedPlan.cluster?.caSha256!==target.expectedCaSha256||scopedPlan.cluster?.name!==target.expectedCluster)refuse('target identity/scope');
 const expected=`docker.io/fabriciobackend/gromesh-ui@${image.indexDigest}`;
 if(scopedPlan.changes?.length!==1||scopedPlan.changes[0].after!==expected||scopedPlan.changes[0].name!==target.deployment
  ||scopedPlan.changes[0].path!=='.spec.template.spec.containers[name=ui].image'||scopedPlan.changes[0].namespace!==target.namespace
  ||!scopedPlan.renderProof?.chartSha256||!scopedPlan.renderProof?.manifestSha256||!scopedPlan.liveObjects?.length)refuse('exact image/render/live-object proof');
 if(!context?.requester||!/^gromesh-gateway\/gromesh-dev\/gromesh-deploy$/.test(context.job??'')||!/^[1-9][0-9]*$/.test(context.buildId??''))refuse('authenticated Jenkins requester/build');
 const blockers=[];
 if(migrations?.liveSchemaVerified!==true||migrations.status!=='NO_PENDING_MIGRATIONS')blockers.push('LIVE_SCHEMA_OR_PENDING_MIGRATIONS');
 if(compatibility?.uiDigest!==image.indexDigest||typeof input.unchangedCpImage!=='string'||!/@sha256:[a-f0-9]{64}$/.test(input.unchangedCpImage)||compatibility.cpImage!==input.unchangedCpImage||compatibility.tested!==true||compatibility.schemaJournalHash!==migrations?.journalHash)blockers.push('UI_OLD_CP_SCHEMA_COMPATIBILITY');
 if(input.backup?.verified!==true||!isDigest(input.backup?.digest))blockers.push('VERIFIED_BACKUP_REQUIRED');
 if(input.rollbackImageAvailable!==true)blockers.push('PREVIOUS_IMAGE_PULL_PROOF');
 const now=context.now;
 if(!Number.isFinite(now))refuse('trusted clock');
 const proof=input.targetImageProof;
 const targetImageProof=proof?.available===true&&proof.reference===expected&&proof.method==='ANONYMOUS_FULL_PULL'
  &&Number.isFinite(Date.parse(proof.observedAt))&&Date.parse(proof.observedAt)<=now&&now-Date.parse(proof.observedAt)<=60000
  ?{reference:expected,available:true,method:proof.method}:null;
 if(!targetImageProof)blockers.push('TARGET_IMAGE_FULL_PULL_REQUIRED');
 let rollbackRequest=null;
 if(input.operation==='ROLLBACK_PLAN'){
  rollbackRequest=createRollbackPlan({...input.rollbackProof,component:'ui'});
  if(rollbackRequest.previousDigest!==image.indexDigest||rollbackRequest.currentDigest!==scopedPlan.changes[0].before.split('@').at(-1)
   ||rollbackRequest.previousReleaseHash!==canonicalHash(input.releaseEnvelope))refuse('rollback history does not match selected release/current live image');
 }
 const payload={schema:'gromesh-cd-plan/v1',environment:'DEV',component:'ui',operation:input.operation==='ROLLBACK_PLAN'?'ROLLBACK_PLAN':'DEPLOY_PLAN',requester:context.requester,job:context.job,buildId:context.buildId,
  nonce:randomBytes(16).toString('hex'),issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+30*60*1000).toISOString(),sourceSha:release.source.sha,
  releaseHash:canonicalHash(input.releaseEnvelope),pipelineSha:release.pipelineSha,target,changes:scopedPlan.changes,scopedPlan,migrations:migrations??null,compatibility:compatibility??null,backup:input.backup??null,targetImageProof,rollbackRequest,
  blockers,eligibleForFutureApproval:blockers.length===0,applyEnabled:J5_POLICY.applyEnabled};
 return {...payload,planHash:canonicalHash(payload)};
}
export function createRollbackPlan(input){
 if(input.schemaCompatible!==true||input.previousImageAvailable!==true||input.backupVerified!==true||!isDigest(input.previousDigest))refuse('rollback schema compatibility, backup and previous image availability required');
 if(input.component!=='ui'||!/^[a-f0-9]{64}$/.test(input.previousPlanHash??'')||!/^[a-f0-9]{64}$/.test(input.currentPlanHash??'')||input.previousPlanHash===input.currentPlanHash)refuse('rollback exact UI plans required');
 if(input.historyVerified!==true||!isDigest(input.currentDigest)||!/^[a-f0-9]{64}$/.test(input.previousReleaseHash??''))refuse('rollback verified release/plan history required');
 return {schema:'gromesh-rollback-request/v1',component:'ui',previousDigest:input.previousDigest,currentDigest:input.currentDigest,previousReleaseHash:input.previousReleaseHash,previousPlanHash:input.previousPlanHash,currentPlanHash:input.currentPlanHash,
  requiresNewScopedPlan:true,requiresNewApproval:true,applyEnabled:false};
}
export async function applyPlan(plan,receipt,policy,adapters){
 // Changing job parameters, uploading a receipt, or editing a candidate cannot enable writes.
 if(!J5_POLICY.applyEnabled||!J5_POLICY.firstDevApplyAuthorized)refuse('APPLY disabled: no real deploy authorized in J5');
 // Activation requires a reviewed source change to the constant above, never a user parameter.
 if(plan.environment!=='DEV'||plan.blockers?.length||plan.eligibleForFutureApproval!==true)refuse('ineligible DEV plan');
 authorizePlan(plan,receipt,policy,{now:adapters.now(),consumedNonces:await adapters.readConsumedNonces()});
 const current=await adapters.revalidate(plan);
 for(const field of ['sourceSha','releaseHash','pipelineSha','target','changes','scopedPlan','migrations','compatibility','backup','targetImageProof','rollbackRequest'])
  if(canonicalHash(field==='scopedPlan'?semanticScopedPlan(current[field]):current[field])!==canonicalHash(field==='scopedPlan'?semanticScopedPlan(plan[field]):plan[field]))refuse('live drift invalidates approval');
 authorizePlan(plan,receipt,policy,{now:adapters.now(),consumedNonces:await adapters.readConsumedNonces()});
 // Atomic durable reservation must succeed before the protected original guard performs its late checks.
 await adapters.reserveNonce(plan.nonce,plan.planHash);
 return adapters.scopedGuard({...adapters.protectedOptions,mode:'apply',noHooks:true,authorizedHooks:[]});
}
