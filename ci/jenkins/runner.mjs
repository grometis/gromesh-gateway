import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateSource,isSha,assertCompleteCi,requiredStages } from './policy.mjs';
import { inspectWorker } from './worker.mjs';
import { runStage,runCommand } from './ci.mjs';
const exec=promisify(execFile);

export function contextFromEnvironment(env,pipelineSha) {
  const source={repository:'grometis/gromesh-gateway',sha:env.GROMESH_SOURCE_SHA,event:env.GROMESH_SOURCE_EVENT,
    branch:env.GROMESH_SOURCE_BRANCH,pr:env.GROMESH_PR_NUMBER?Number(env.GROMESH_PR_NUMBER):null,baseSha:env.GROMESH_BASE_SHA||null};
  if(source.event==='pull_request') {
    if(!isSha(env.GROMESH_PR_HEAD_SHA))throw new Error('Verified PR head SHA required');
    source.headSha=env.GROMESH_PR_HEAD_SHA;
  }
  validateSource(source);
  const job=env.JOB_NAME,id=env.BUILD_NUMBER;
  if(!isSha(pipelineSha) || !/^gromesh-gateway\/gromesh-ci\/gromesh-(main|prs|branches)$/.test(job ?? '') || !/^[1-9][0-9]*$/.test(id ?? ''))throw new Error('Invalid trusted job/pipeline identity');
  if(job.endsWith('/gromesh-main') && (!['push','manual'].includes(source.event) || source.branch!=='main'))throw new Error('Main job source refused');
  if(job.endsWith('/gromesh-prs') && source.event!=='pull_request')throw new Error('PR job cannot masquerade as main');
  if(job.endsWith('/gromesh-branches') && (!['push','manual'].includes(source.event) || source.branch==='main'))throw new Error('Branch job identity refused');
  const url='https://jenkins.grometis.com'+job.split('/').map(p=>'/job/'+p).join('')+'/'+id+'/';
  if(env.BUILD_URL!==url)throw new Error('Official build URL required');
  return {schema:'gromesh-jenkins-ci/v1',source,pipelineSha,build:{job,id,url}};
}

export function assembleCiReport(context,stages,tools) {
  const report={...context,stages,tools};
  const expected={source:context.source,pipelineSha:context.pipelineSha,job:context.build.job,buildId:context.build.id};
  try {assertCompleteCi(report,expected);return {...report,coverage:'COMPLETE',conclusion:'success'};}
  catch {return {...report,coverage:'PARTIAL',conclusion:'failure'};}
}

async function versions() {
  const pnpm=(await exec('pnpm',['--version'],{timeout:30000,maxBuffer:4096})).stdout.trim();
  const go=(await exec('go',['version'],{timeout:30000,maxBuffer:4096})).stdout.trim().split(' ')[2];
  return {node:process.version,pnpm,go};
}

export function buildTaskEnvironment(context,e) {
  if(!/^[a-f0-9]{32}$/.test(e.GROMESH_CI_RUN ?? ''))throw new Error('Random per-build identity required');
  if(!isSha(e.GROMESH_DIFF_BASE_SHA))throw new Error('Verified comparison SHA required');
  if(!/^unix:\/\/\/run\/user\/[1-9][0-9]*\/docker.sock$/.test(e.DOCKER_HOST ?? ''))throw new Error('Dedicated rootless Docker endpoint required');
  const state='/tmp/gromesh-jenkins-'+e.GROMESH_CI_RUN;
  const clean={PATH:'/opt/gromesh/tools/node/bin:/opt/gromesh/tools/bin:/usr/local/bin:/usr/bin:/bin',HOME:e.HOME,USER:e.USER,
    LANG:'C.UTF-8',CI:'1',JENKINS_URL:'https://jenkins.grometis.com/',DOCKER_HOST:e.DOCKER_HOST,
    GROMESH_CI_RUN:e.GROMESH_CI_RUN,GROMESH_CI_STATE:state,GROMESH_BASE_SHA:e.GROMESH_DIFF_BASE_SHA,
    SCAN_PLATFORM:e.SCAN_PLATFORM||'',DOCKER_CONFIG:join(state,'docker-config'),
    npm_config_cache:join(state,'npm-cache'),npm_config_store_dir:join(state,'pnpm-store'),
    npm_config_userconfig:'/opt/gromesh/jenkins/npmrc',npm_config_globalconfig:'/opt/gromesh/jenkins/npmrc',
    GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'credential.helper',GIT_CONFIG_VALUE_0:'',
    NODE_OPTIONS:'--max-old-space-size=2048'};
  return clean;
}

async function main() {
  const [command,id]=process.argv.slice(2);
  if(command==='verify-report') {
    const report=JSON.parse(await readFile(resolve(id),'utf8'));
    const context=contextFromEnvironment(process.env,process.env.GROMESH_PIPELINE_SHA);
    assertCompleteCi(report,{source:context.source,pipelineSha:context.pipelineSha,job:context.build.job,buildId:context.build.id});
    console.log(JSON.stringify({status:'COMPLETE_CI',sha:context.source.sha,build:context.build.id}));return;
  }
  if(!['stage','tools'].includes(command) || (command==='stage'&&!requiredStages.includes(id)))throw new Error('Unknown runner command/stage');
  let qualified;
  try {qualified=await inspectWorker();}
  catch {console.log(JSON.stringify({status:'WORKER_NOT_QUALIFIED',operation:command,stage:id??null}));process.exitCode=78;return;}
  const context=contextFromEnvironment(process.env,qualified.policy.pipelineSha);
  if(process.env.GROMESH_PIPELINE_SHA!==qualified.policy.pipelineSha)throw new Error('Installed runtime differs from approved SCM revision');
  if(command==='tools') {console.log(JSON.stringify(await versions()));return;}
  const sha=(await exec('git',['rev-parse','HEAD'],{timeout:10000,maxBuffer:4096})).stdout.trim();
  if(sha!==context.source.sha)throw new Error('Checked-out SHA differs from the GitHub-verified source');
  const env=buildTaskEnvironment(context,process.env);
  await mkdir(env.DOCKER_CONFIG,{recursive:true,mode:0o700});
  const output=resolve(process.env.GROMESH_CI_OUTPUT||'../results');
  const abort=new AbortController();
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>abort.abort());
  const result=await runStage(id,{cwd:process.cwd(),output,env,signal:abort.signal,timeoutMs:90*60*1000});
  const row={...result,sha:context.source.sha,pipelineSha:context.pipelineSha,build:context.build,workerId:qualified.facts.id};
  if(id==='image-scan' && result.status==='SUCCESS')row.platforms=[env.SCAN_PLATFORM];
  await writeFile(join(output,id+'.json'),JSON.stringify(row,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({stage:id,status:result.status,exitCode:result.exitCode,durationMs:result.durationMs,sha:context.source.sha}));
  if(result.status!=='SUCCESS'||result.complete!==true)process.exitCode=1;
  // Database containers are owned by this nonce; no volume/global cleanup is performed.
  if(id==='migration-regression' || result.status!=='SUCCESS') {
    const cleanup=await runCommand(['/bin/bash','/opt/gromesh/jenkins/stages/cleanup.sh'],{env,timeoutMs:45000});
    if(cleanup.status!=='SUCCESS')process.exitCode=1;
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().catch(()=>{console.log(JSON.stringify({status:'CI_RUNNER_REFUSED'}));process.exitCode=1;});
}
