import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GitHubApp } from './github-app.mjs';
import { postCiCheck } from './github-report.mjs';
const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const context=()=>({source:{repository:'grometis/gromesh-gateway',sha:'a'.repeat(40),event:'push',branch:'main',pr:null,baseSha:null},pipelineSha:'b'.repeat(40),build:{job:'gromesh-gateway/gromesh-ci/gromesh-main',id:'17',url:'https://jenkins.grometis.com/job/gromesh-gateway/job/gromesh-ci/job/gromesh-main/17/'}});
test('an incomplete report posts failure to the trusted SHA instead of claiming green CI',async()=>{
  const requests=[];
  const client=new GitHubApp({appId:'123',installationId:'456',privateKey,transport:async(url,options)=>{requests.push({url,options});return {ok:true,status:201,json:async()=>url.includes('access_tokens')?{token:'fixture-only',expires_at:'2099-01-01T00:00:00Z'}:{id:101}};}});
  const c=context();
  const result=await postCiCheck(client,{...c,schema:'gromesh-jenkins-ci/v1',source:{...c.source,sha:'f'.repeat(40)},stages:[],tools:{}},c);
  assert.equal(result.conclusion,'failure');
  const body=JSON.parse(requests.at(-1).options.body);assert.equal(body.head_sha,'a'.repeat(40));assert.equal(body.conclusion,'failure');assert.equal(body.name,'jenkins-ci-main');
});
test('the reporting CLI cannot borrow a host gh credential or run without protected configuration',()=>{
  const r=spawnSync(process.execPath,[fileURLToPath(new URL('./github-report.mjs',import.meta.url)),'does-not-exist.json'],{encoding:'utf8',env:{PATH:process.env.PATH,GH_TOKEN:'DO_NOT_USE_OPERATOR_TOKEN'}});
  assert.equal(r.status,78);assert.match(r.stdout,/GITHUB_INTEGRATION_NOT_CONFIGURED/);assert.equal(r.stdout.includes('DO_NOT_USE_OPERATOR_TOKEN'),false);
});
