import { lstat,readFile,realpath } from 'node:fs/promises';
import { createPrivateKey } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { GitHubApp } from './github-app.mjs';
import { contextFromEnvironment } from './runner.mjs';
import { assertCompleteCi,validateSource,isSha,requiredStages } from './policy.mjs';

export async function postCiCheck(client,report,context) {
  validateSource(context.source);
  if(context.source.event==='pull_request'&&!isSha(context.source.headSha))throw new Error('PR check head required');
  const expected={source:context.source,pipelineSha:context.pipelineSha,job:context.build.job,buildId:context.build.id};
  let conclusion='failure';
  try {assertCompleteCi(report,expected);conclusion='success';}catch{}
  const passed=new Set((Array.isArray(report.stages)?report.stages:[]).filter(x=>requiredStages.includes(x.id)&&x.status==='SUCCESS'&&x.exitCode===0).map(x=>x.id)).size;
  const response=await client.check({sha:context.source.headSha??context.source.sha,buildUrl:context.build.url,
    externalId:context.build.job+':'+context.build.id+':'+context.pipelineSha,conclusion,
    summary:`${passed}/${requiredStages.length} mandatory stages passed. Incomplete CI never replaces GitHub Actions. Tested SHA ${context.source.sha}. Pipeline ${context.pipelineSha}.`,report,expected});
  if(!Number.isSafeInteger(response.id))throw new Error('Invalid GitHub check response');
  return {checkId:response.id,conclusion,sha:context.source.headSha??context.source.sha,testedSha:context.source.sha};
}

async function protectedJson(path) {
  const info=await lstat(path);
  if(!info.isFile()||info.uid!==0||(info.mode&0o022)!==0||await realpath(path)!==path||info.size>65536)throw new Error('Protected coordinator configuration required');
  const parent=await lstat(dirname(path));
  if(!parent.isDirectory()||parent.uid!==0||(parent.mode&0o022)!==0)throw new Error('Protected coordinator directory required');
  return JSON.parse(await readFile(path,'utf8'));
}

export async function coordinatorClient() {
  if(dirname(fileURLToPath(import.meta.url))!=='/opt/gromesh/jenkins'||!process.getuid||process.getuid()===0)throw new Error('Dedicated coordinator runtime required');
  const config=await protectedJson('/etc/gromesh-jenkins/github-app.json');
  const revision=await protectedJson('/opt/gromesh/jenkins/revision.json');
  if(config.role!=='github-coordinator'||config.hostname!==hostname()||config.pipelineSha!==revision.sha
      ||config.pipelineSha!==process.env.GROMESH_PIPELINE_SHA||!isSha(revision.sha)
      ||!Array.isArray(config.allowedJobs)||!config.allowedJobs.includes(process.env.JOB_NAME))throw new Error('Coordinator identity mismatch');
  const keyFile=process.env.GROMESH_GITHUB_APP_KEY_FILE;
  const stat=await lstat(keyFile);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077)!==0||stat.size>65536)throw new Error('Dedicated Jenkins secret-file credential required');
  const privateKey=createPrivateKey(await readFile(keyFile));
  return {config,client:new GitHubApp({appId:config.appId,installationId:config.installationId,privateKey})};
}

async function main() {
  let credentials;
  try {credentials=await coordinatorClient();}
  catch {console.log(JSON.stringify({status:'GITHUB_INTEGRATION_NOT_CONFIGURED'}));process.exitCode=78;return;}
  const context=contextFromEnvironment(process.env,credentials.config.pipelineSha);
  const stat=await lstat(process.argv[2]);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)throw new Error('Invalid CI report file');
  const report=JSON.parse(await readFile(process.argv[2],'utf8'));
  console.log(JSON.stringify(await postCiCheck(credentials.client,report,context)));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().catch(()=>{console.log(JSON.stringify({status:'GITHUB_CHECK_FAILED'}));process.exitCode=1;});
}
