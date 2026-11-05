import { isSha } from './policy.mjs';
import requirements from './plugins-git-prerequisites.json' with {type:'json'};
const names=['main','prs','branches','discovery','status'];
export function imageJobDefinition(pipelineSha){if(!isSha(pipelineSha))throw new Error('Reviewed immutable pipeline SHA required');return {name:'gromesh-artifacts/gromesh-images',pipelineSha,scriptPath:'Jenkinsfile.images'};}
// Supply snapshots read by the authenticated operator from PluginManager; never from a build parameter.
export function assertScmActivation({baseline,current,classes,dependencyMinimumsSatisfied}){
 if(!baseline||Object.keys(baseline).length!==65||!current||Object.entries(baseline).some(([id,version])=>current[id]?.version!==version||current[id]?.active!==true)
  ||requirements.additions.some(p=>current[p.name]?.version!==p.version||current[p.name]?.active!==true)
  ||!requirements.requiredClasses.every(c=>classes?.includes(c))||dependencyMinimumsSatisfied!==true)throw new Error('SCM activation blocked: preserve65 and verify pinned Git plugins/dependencies/classes');
 return true;
}
export function jobDefinitions(pipelineSha){
  if(!isSha(pipelineSha))throw new Error('Reviewed immutable pipeline SHA required');
  return names.map(name=>({name:`gromesh-gateway/gromesh-ci/gromesh-${name}`,pipelineSha,scriptPath:['discovery','status'].includes(name)?'Jenkinsfile.'+name:'Jenkinsfile.ci'}));
}
export function renderJobXml(job){
  const image=job.name==='gromesh-artifacts/gromesh-images';
  if((!image&&!names.some(n=>job.name===`gromesh-gateway/gromesh-ci/gromesh-${n}`))||!isSha(job.pipelineSha)
    ||job.scriptPath!==(image?'Jenkinsfile.images':job.name.endsWith('discovery')?'Jenkinsfile.discovery':job.name.endsWith('status')?'Jenkinsfile.status':'Jenkinsfile.ci'))throw new Error('Unapproved job definition');
  return `<?xml version="1.0" encoding="UTF-8"?>
<flow-definition plugin="workflow-job"><description>J5 PREPARED: disabled until review, worker qualification, RBAC and credentials. GitHub Actions remains authoritative.</description>
<keepDependencies>false</keepDependencies><properties/><definition class="org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition" plugin="workflow-cps">
<scm class="hudson.plugins.git.GitSCM" plugin="git"><configVersion>2</configVersion><userRemoteConfigs><hudson.plugins.git.UserRemoteConfig><url>https://github.com/grometis/gromesh-gateway.git</url></hudson.plugins.git.UserRemoteConfig></userRemoteConfigs><branches><hudson.plugins.git.BranchSpec><name>${job.pipelineSha}</name></hudson.plugins.git.BranchSpec></branches><doGenerateSubmoduleConfigurations>false</doGenerateSubmoduleConfigurations><submoduleCfg class="empty-list"/><extensions/></scm>
<scriptPath>${job.scriptPath}</scriptPath><lightweight>false</lightweight></definition><triggers/><disabled>true</disabled></flow-definition>\n`;
}
