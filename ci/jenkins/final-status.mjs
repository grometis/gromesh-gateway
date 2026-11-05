import { assertCompleteCi,validateSource,isSha } from './policy.mjs';
export function checkName(job){const names={'gromesh-gateway/gromesh-ci/gromesh-main':'jenkins-ci-main','gromesh-gateway/gromesh-ci/gromesh-prs':'jenkins-ci-pr','gromesh-gateway/gromesh-ci/gromesh-branches':'jenkins-ci-branch'};if(!names[job])throw new Error('Unapproved CI check job');return names[job];}
export function checkIdentity(context){
 checkName(context?.build?.job);validateSource(context.source);
 const b=context.build,path=b.job.split('/').map(s=>'/job/'+s).join('');
 if(!/^[1-9][0-9]*$/.test(b.id??'')||b.url!==`https://jenkins.grometis.com${path}/${b.id}/`||!isSha(context.pipelineSha))throw new Error('CI check build identity');
 return {name:checkName(b.job),sha:context.source.headSha??context.source.sha,externalId:`${b.job}:${b.id}:${context.pipelineSha}`,url:b.url};
}
export function finalConclusion(report,context,run){
 try{
  const identity=checkIdentity(context);
  if(run?.building!==false||run.result!=='SUCCESS'||run.job!==context.build.job||run.id!==context.build.id||run.pipelineSha!==context.pipelineSha||run.sourceSha!==identity.sha)return 'failure';
  assertCompleteCi(report,{source:context.source,pipelineSha:context.pipelineSha,job:context.build.job,buildId:context.build.id});return 'success';
 }catch{return 'failure';}
}
