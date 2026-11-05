import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile,mkdtemp,mkdir,writeFile,chmod,rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname,join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { signEnvelope } from './release.mjs';
import { prepareReferenceEdits,referenceFiles } from './reference-patch.mjs';
test('reference preparation refuses candidate or absent digests before touching any source file',async()=>{
 const {privateKey,publicKey}=generateKeyPairSync('ed25519'),key={keyId:'fixture',publicKey};
 const payload={schema:'gromesh-candidate-release/v1',official:false};
 await assert.rejects(prepareReferenceEdits(signEnvelope(payload,{privateKey,keyId:'fixture',purpose:'release'}),key,new Map(),{lookup:async()=>null}));
});
test('signed official fixture plus independently matching registry digests prepares edits without mutating current files or third-party pins',async()=>{
 const {privateKey,publicKey}=generateKeyPairSync('ed25519'),sha='a'.repeat(40);
 const payload={schema:'gromesh-release/v1',official:true,registry:'docker.io/fabriciobackend',source:{sha},artifacts:['control-plane','ui','agent','kong'].map((component,i)=>({component,indexDigest:'sha256:'+String(i+1).repeat(64)}))};
 const envelope=signEnvelope(payload,{privateKey,keyId:'fixture',purpose:'release'}),files=new Map(await Promise.all(referenceFiles.map(async p=>[p,await readFile(p,'utf8')])));
 const lookup=async component=>payload.artifacts.find(a=>a.component===component).indexDigest;
 const result=await prepareReferenceEdits(envelope,{publicKey,keyId:'fixture'},files,{lookup});
 assert.ok(result.edits.length>=4);assert.equal(result.writesPerformed,false);
 const yaml=result.edits.find(e=>e.path==='deploy/helm/data-plane/values.yaml').after;
 assert.match(yaml,/docker.io\/fabriciobackend\/gromesh-kong/);assert.match(yaml,/repository: timberio\/vector/);
 assert.equal(files.get('deploy/helm/data-plane/values.yaml'),await readFile('deploy/helm/data-plane/values.yaml','utf8'));
 const directory=await mkdtemp(join(tmpdir(),'j5-reference-ci-')),nonce=randomBytes(16).toString('hex'),state='/tmp/gromesh-jenkins-'+nonce;
 try{
  for(const edit of result.edits){const path=join(directory,edit.path);await mkdir(dirname(path),{recursive:true});await writeFile(path,edit.after);}
  for(const file of ['scripts/kong-image-ref.mjs','ci/jenkins/stages/checks-start.sh','ci/jenkins/stages/common.sh']){await mkdir(dirname(join(directory,file)),{recursive:true});await writeFile(join(directory,file),await readFile(file));}
  await mkdir(join(directory,'bin'));for(const file of ['docker','curl']){await writeFile(join(directory,'bin',file),'#!/bin/sh\nexit 0\n');await chmod(join(directory,'bin',file),0o700);}
  const r=spawnSync('/bin/bash',['ci/jenkins/stages/checks-start.sh'],{cwd:directory,env:{PATH:join(directory,'bin')+':'+dirname(process.execPath)+':/usr/bin:/bin',JENKINS_URL:'https://jenkins.grometis.com/',DOCKER_HOST:'unix:///run/user/1000/docker.sock',GROMESH_CI_RUN:nonce,GROMESH_CI_STATE:state},encoding:'utf8',timeout:5000});
  assert.equal(r.status,0,'Generated digest edits must pass checks-start with Docker/curl fully stubbed');
 }finally{await rm(directory,{recursive:true,force:true});await rm(state,{recursive:true,force:true});}
 await assert.rejects(prepareReferenceEdits(envelope,{publicKey,keyId:'fixture'},files,{lookup:async()=>null}),/registry/i);
});
