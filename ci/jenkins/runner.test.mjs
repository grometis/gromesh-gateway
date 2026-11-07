import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { contextFromEnvironment, assembleCiReport, buildTaskEnvironment } from './runner.mjs';
const env=()=>({JOB_NAME:'gromesh-gateway/gromesh-ci/gromesh-main',BUILD_NUMBER:'17',BUILD_URL:'https://jenkins.grometis.com/job/gromesh-gateway/job/gromesh-ci/job/gromesh-main/17/',GROMESH_SOURCE_SHA:'a'.repeat(40),GROMESH_SOURCE_EVENT:'push',GROMESH_SOURCE_BRANCH:'main',GROMESH_PR_NUMBER:'',GROMESH_BASE_SHA:''});
test('context binds the official URL, immutable pipeline and exact job build',()=>{
  const c=contextFromEnvironment(env(),'b'.repeat(40));
  assert.equal(c.source.sha,'a'.repeat(40));assert.equal(c.pipelineSha,'b'.repeat(40));assert.equal(c.build.id,'17');
  assert.throws(()=>contextFromEnvironment({...env(),BUILD_URL:'http://localhost:18081'},'b'.repeat(40)));
});
test('a PR job cannot masquerade as a main push',()=>{
  assert.throws(()=>contextFromEnvironment({...env(),JOB_NAME:'gromesh-gateway/gromesh-ci/gromesh-prs'},'b'.repeat(40)));
});
test('branch jobs preserve their branch identity and manual main builds are explicitly manual',()=>{
  const c=contextFromEnvironment({...env(),JOB_NAME:'gromesh-gateway/gromesh-ci/gromesh-branches',BUILD_URL:env().BUILD_URL.replace('gromesh-main','gromesh-branches'),GROMESH_SOURCE_BRANCH:'feature/ci'},'b'.repeat(40));
  assert.equal(c.source.branch,'feature/ci');
  const manual=contextFromEnvironment({...env(),GROMESH_SOURCE_EVENT:'manual'},'b'.repeat(40));assert.equal(manual.source.event,'manual');
});
test('a partial CI result never becomes complete',()=>{
  const c=contextFromEnvironment(env(),'b'.repeat(40));
  const r=assembleCiReport(c,[{id:'install',status:'SUCCESS',exitCode:0,durationMs:1,artifacts:[]}],{node:'v26.13.0',pnpm:'10.28.0',go:'go1.27.3'});
  assert.equal(r.coverage,'PARTIAL');assert.equal(r.conclusion,'failure');
});
test('the stage CLI refuses a non-qualified Mac/worker before starting integration',()=>{
  const r=spawnSync(process.execPath,[fileURLToPath(new URL('./runner.mjs',import.meta.url)),'stage','unit-integration'],{env:{...process.env,...env(),DOCKER_HOST:'tcp://192.168.15.3:2375'},encoding:'utf8'});
  assert.equal(r.status,78);assert.match(r.stdout,/WORKER_NOT_QUALIFIED/);
});
test('task environment does not forward operator tokens, kubeconfig or arbitrary PATH',()=>{
  const c=contextFromEnvironment(env(),'b'.repeat(40));
  const clean=buildTaskEnvironment(c,{HOME:'/home/jenkins',USER:'jenkins',PATH:'/attacker/bin',GH_TOKEN:'secret',GITHUB_TOKEN:'secret',AWS_SECRET_ACCESS_KEY:'secret',KUBECONFIG:'/n2/admin.conf',GROMESH_CI_RUN:'a'.repeat(32),GROMESH_DIFF_BASE_SHA:'d'.repeat(40),DOCKER_HOST:'unix:///run/user/1000/docker.sock'});
  for(const key of ['GH_TOKEN','GITHUB_TOKEN','AWS_SECRET_ACCESS_KEY','KUBECONFIG'])assert.equal(key in clean,false);
  assert.equal(clean.PATH.includes('/attacker/bin'),false);
  assert.equal(clean.GROMESH_BASE_SHA,'d'.repeat(40));
  assert.equal(clean.DOCKER_CONFIG,'/tmp/gromesh-jenkins-'+'a'.repeat(32)+'/docker-config');
});
test('missing comparison SHA cannot quietly produce an empty image scan',()=>{
  assert.throws(()=>buildTaskEnvironment(contextFromEnvironment(env(),'b'.repeat(40)),{GROMESH_CI_RUN:'a'.repeat(32),DOCKER_HOST:'unix:///run/user/1000/docker.sock'}),/comparison/i);
});
test('PR context records the tested merge separately from the check head SHA',()=>{
  const pr={...env(),JOB_NAME:'gromesh-gateway/gromesh-ci/gromesh-prs',BUILD_URL:env().BUILD_URL.replace('gromesh-main','gromesh-prs'),GROMESH_SOURCE_EVENT:'pull_request',GROMESH_SOURCE_BRANCH:'feature/ci',GROMESH_PR_NUMBER:'300',GROMESH_BASE_SHA:'c'.repeat(40),GROMESH_PR_HEAD_SHA:'d'.repeat(40)};
  assert.equal(contextFromEnvironment(pr,'b'.repeat(40)).source.headSha,'d'.repeat(40));
  delete pr.GROMESH_PR_HEAD_SHA;assert.throws(()=>contextFromEnvironment(pr,'b'.repeat(40)),/head/i);
});
