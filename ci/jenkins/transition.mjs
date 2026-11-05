import { assertCompleteCi,canonicalHash,isSha,isDigest,requiredStages } from './policy.mjs';
import { verifyEnvelope } from './release.mjs';
import { checkIdentity,finalConclusion } from './final-status.mjs';
export const workflowCoverage=Object.freeze({
 'ci.yml':['Jenkinsfile.ci',...requiredStages,'Jenkinsfile.status'],
 'images.yml':['Jenkinsfile.images','native-amd64','native-arm64','SBOM','CRITICAL-scan','anonymous-pull'],
 'image-digests.yml':['reviewed-reference-patch','delivery-App-PR','no-automatic-merge'],
 'kong-image-build.yml':['native-kong','version-3.9.4','nonroot','compose-acceptance','SBOM','CRITICAL-scan'],
 'kong-image-candidate.yml':['conditional-PR-native-kong','credential-free-candidate-evidence'],
 'kong-image.yml':['Jenkinsfile.images','native-kong-manifest','signed-provenance']
});
// Assessment only. Uploaded evidence cannot enable a job or grant deployment/publisher rights.
export function assessCutover(evidence,trusted){
 const blockers=[];const require=(value,reason)=>{if(!value)blockers.push(reason);};
 require(isSha(trusted.pipelineSha),'REVIEWED_PIPELINE_SHA');
 require(Number.isFinite(trusted.now),'TRUSTED_CLOCK_REQUIRED');
 require(evidence.actions?.allActive===true,'ACTIONS_MUST_REMAIN_ACTIVE_DURING_EQUIVALENCE');
 require(evidence.ruleset?.id===25344054&&evidence.ruleset.enforcement==='active'&&evidence.ruleset.requiredChecks?.includes('ci-ok'),'EXISTING_PROTECTION_REQUIRED');
 const byEvent=new Map();
 for(const item of evidence.ciRuns??[]){
  try{
   const {report,run,check}=item,identity=checkIdentity({source:report.source,pipelineSha:report.pipelineSha,build:report.build});
   assertCompleteCi(report,{source:report.source,pipelineSha:trusted.pipelineSha,job:report.build.job,buildId:report.build.id});
   if(finalConclusion(report,{source:report.source,pipelineSha:report.pipelineSha,build:report.build},run)!=='success'||check?.status!=='completed'||check.conclusion!=='success'
    ||check.app?.id!==trusted.appId||!Number.isSafeInteger(trusted.appId)||check.name!==identity.name||check.head_sha!==identity.sha||check.external_id!==identity.externalId||check.details_url!==identity.url
    ||!Number.isFinite(Date.parse(run.completedAt))||Date.parse(run.completedAt)>trusted.now||trusted.now-Date.parse(run.completedAt)>86400000)throw Error('Unverified actual final run/check');
   byEvent.set(report.source.event,item);
  }catch{blockers.push('ACTUAL_FINAL_CI_AND_APP_CHECK_REQUIRED');}
 }
 require(byEvent.has('push')&&byEvent.get('push').report.source.branch==='main'&&byEvent.has('pull_request'),'FULL_MAIN_AND_PR_CI_REQUIRED');
 let release;
 try{
  release=verifyEnvelope(evidence.candidateEnvelope,{...trusted.releaseKey,purpose:'release'});
  if(release.schema!=='gromesh-candidate-release/v1'||release.official!==false||release.pipelineSha!==trusted.pipelineSha
   ||release.source.sha!==byEvent.get('push')?.report.source.sha||canonicalHash(release.ci)!==canonicalHash(byEvent.get('push')?.report.build)
   ||release.artifacts?.length!==4||new Set(release.artifacts.map(a=>a.component)).size!==4)throw Error('Candidate identity');
  for(const component of ['control-plane','ui','agent','kong']){
   const a=release.artifacts.find(a=>a.component===component),proof=evidence.hubReadbacks?.find(p=>p.component===component);
   if(!isDigest(a?.indexDigest)||a.platforms?.length!==2||!['linux/amd64','linux/arm64'].every(p=>a.platforms.includes(p))
    ||!proof||proof.digest!==a.indexDigest||proof.anonymousFullPull!=='SUCCESS'||proof.signatureVerified!==true||proof.sbomVerified!==true||proof.scannedDigest!==a.indexDigest||proof.critical!==0)throw Error('Registry proof');
  }
 }catch{blockers.push('SIGNED_CANDIDATE_RELEASE_AND_REAL_HUB_READBACK_REQUIRED');}
 const coverage=evidence.coverage;
 require(coverage&&Object.keys(workflowCoverage).every(file=>coverage[file]?.tested===true&&coverage[file]?.pipelineSha===trusted.pipelineSha
  &&/^[a-f0-9]{64}$/.test(coverage[file]?.evidenceSha256??'')),'ALL_SIX_WORKFLOWS_REQUIRE_EQUIVALENCE_EVIDENCE');
 require(evidence.review?.pipelineSha===trusted.pipelineSha&&evidence.review.accepted===true&&evidence.review.openCritical===0&&evidence.review.openImportant===0
  &&/^[a-f0-9]{64}$/.test(evidence.review.evidenceSha256??''),'INDEPENDENT_REVIEW_REQUIRED');
 require(evidence.authorization?.pipelineSha===trusted.pipelineSha&&evidence.authorization.candidateHash===canonicalHash(evidence.candidateEnvelope??null)
  &&evidence.authorization.authorizedBy===trusted.cutoverApprover&&typeof trusted.cutoverApprover==='string'&&trusted.cutoverApprover.length>0
  &&evidence.authorization.explicitCutover===true,'EXPLICIT_CUTOVER_AUTHORIZATION_REQUIRED');
 require(evidence.jenkins?.rbacQualified===true&&evidence.jenkins.recoveryQualified===true&&evidence.jenkins.workersQualified===true,'LIVE_JENKINS_WORKER_RBAC_RECOVERY_QUALIFICATION_REQUIRED');
 return {schema:'gromesh-cutover-assessment/v1',ready:blockers.length===0,blockers:[...new Set(blockers)],pipelineSha:trusted.pipelineSha,performsWrites:false};
}
export function rollbackTransitionPlan(snapshot){
 if(snapshot?.rulesetId!==25344054||snapshot.requiredCheck!=='ci-ok'||!Array.isArray(snapshot.actionsWorkflowFiles)
  ||!Object.keys(workflowCoverage).every(file=>snapshot.actionsWorkflowFiles.includes(file)))throw Error('Original protection/workflow snapshot required');
 return {automatic:false,requiresHumanAuthorization:true,steps:[
  'Suspender novas publicações e deployments Jenkins; aguardar e conferir ausência de runs ativos.',
  'Restaurar o snapshot do ruleset com ci-ok obrigatório antes de remover qualquer requisito Jenkins.',
  'Após comprovar ausência de publicador Jenkins ativo, reativar os workflows Actions originais e validar seus checks.',
  'Manter digests, imagens, histórico Jenkins e manifests assinados; não desfazer schema nem executar rollback de workloads.'
 ]};
}
