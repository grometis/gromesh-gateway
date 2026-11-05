import test from 'node:test';
import assert from 'node:assert/strict';
import { finalConclusion,checkName } from './final-status.mjs';
import { requiredStages } from './policy.mjs';
import { generateKeyPairSync } from 'node:crypto';
import { GitHubApp } from './github-app.mjs';
test('a complete-looking JSON never overrides a failed, running or different final Jenkins Run',()=>{
 const context={source:{repository:'grometis/gromesh-gateway',sha:'a'.repeat(40),event:'push',branch:'main',pr:null,baseSha:null},pipelineSha:'b'.repeat(40),build:{job:'gromesh-gateway/gromesh-ci/gromesh-main',id:'17',url:'https://jenkins.grometis.com/job/gromesh-gateway/job/gromesh-ci/job/gromesh-main/17/'}};
 for(const run of [{job:context.build.job,id:'17',result:'FAILURE',building:false,pipelineSha:context.pipelineSha},{job:context.build.job,id:'17',result:null,building:true,pipelineSha:context.pipelineSha},{job:context.build.job,id:'18',result:'SUCCESS',building:false,pipelineSha:context.pipelineSha}])assert.notEqual(finalConclusion({schema:'gromesh-jenkins-ci/v1',...context,stages:[]},context,run),'success');
});
test('PR/main/branch checks cannot mask each other at the same commit',()=>{
 assert.equal(new Set(['main','prs','branches'].map(p=>checkName('gromesh-gateway/gromesh-ci/gromesh-'+p))).size,3);
});
test('HTTP fixture keeps CI in progress, then reconciles final failure even when every test report is green',async()=>{
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048}),calls=[];let check=null;
 const client=new GitHubApp({appId:'123',installationId:'456',privateKey,transport:async(url,options)=>{
  calls.push({url,method:options.method,body:options.body?JSON.parse(options.body):null});
  const response=data=>({ok:true,status:200,json:async()=>data});
  if(url.includes('access_tokens'))return response({token:'fixture-only',expires_at:'2099-01-01T00:00:00Z'});
  if(url.includes('/commits/'))return response({check_runs:check?[check]:[]});
  if(options.method==='POST'){const b=JSON.parse(options.body);check={...b,id:7,app:{id:123}};return response(check);}
  if(options.method==='PATCH'){Object.assign(check,JSON.parse(options.body));return response(check);}throw Error('Unexpected fixture request');
 }});
 const context={source:{repository:'grometis/gromesh-gateway',sha:'a'.repeat(40),event:'push',branch:'main',pr:null,baseSha:null},pipelineSha:'b'.repeat(40),build:{job:'gromesh-gateway/gromesh-ci/gromesh-main',id:'17',url:'https://jenkins.grometis.com/job/gromesh-gateway/job/gromesh-ci/job/gromesh-main/17/'}};
 const report={schema:'gromesh-jenkins-ci/v1',...context,tools:{node:'v26.13.0',pnpm:'10.28.0',go:'go1.27.3'},stages:requiredStages.map(id=>({id,status:'SUCCESS',exitCode:0,durationMs:1,complete:true,tests:{known:true,passed:1,failed:0,skipped:0},artifacts:[{path:'stdout.log',kind:'log',bytes:1,sha256:'a'.repeat(64)},{path:'stderr.log',kind:'log',bytes:0,sha256:'b'.repeat(64)},...(id==='ui-acceptance'?[{path:'screenshots/ui.png',kind:'screenshot',bytes:1,sha256:'c'.repeat(64)}]:[])],...(id==='image-scan'?{platforms:['linux/amd64','linux/arm64']}:{})}))};
 const run={job:context.build.job,id:'17',sourceSha:context.source.sha,pipelineSha:context.pipelineSha,building:false,result:'SUCCESS'};
 assert.equal(finalConclusion(report,context,run),'success');await client.beginCheck(context);assert.equal(check.status,'in_progress');assert.equal(check.conclusion,undefined);
 await client.finishCheck(report,context,{...run,result:'FAILURE'});assert.equal(check.conclusion,'failure');assert.equal(calls.at(-1).method,'PATCH');
 const count=calls.length;await client.finishCheck(report,context,{...run,result:'FAILURE'});assert.equal(calls.length,count+1); // GET only: idempotent final status.
 await assert.rejects(client.finishCheck(report,context,{...run,id:'18'}),/exact|completed/i);
});
