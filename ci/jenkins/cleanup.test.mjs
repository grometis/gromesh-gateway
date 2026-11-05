import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,chmod,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('cleanup gracefully stops only nonce/project-owned containers and preserves volumes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'j5-clean-')),nonce='a'.repeat(32),id='b'.repeat(64),log=join(dir,'commands');
 try{const docker=join(dir,'docker');await writeFile(docker,`#!/bin/sh\ncase "$1" in\nps) echo '${id}' ;;\ninspect) echo "|gromesh-test-${nonce}" ;;\n*) printf '%s\\n' "$*" >> "$LOG" ;;\nesac\n`);await chmod(docker,0o700);
  const env={PATH:dir+':/usr/bin:/bin',LOG:log,JENKINS_URL:'https://jenkins.grometis.com/',DOCKER_HOST:'unix:///run/user/1000/docker.sock',GROMESH_CI_RUN:nonce,GROMESH_CI_STATE:'/tmp/gromesh-jenkins-'+nonce};
  const r=spawnSync('/bin/bash',[fileURLToPath(new URL('./stages/cleanup.sh',import.meta.url))],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  const commands=await readFile(log,'utf8');assert.match(commands,/stop --time 10/);assert.ok(commands.indexOf('stop')<commands.indexOf('rm '));assert.doesNotMatch(commands,/prune|volume|--volumes|rm -f/);
  await writeFile(docker,`#!/bin/sh\ncase "$1" in\nps) echo '${id}' ;;\ninspect) echo 'foreign|other-project' ;;\n*) echo forbidden >> "$LOG" ;;\nesac\n`);
  const denied=spawnSync('/bin/bash',[fileURLToPath(new URL('./stages/cleanup.sh',import.meta.url))],{env,encoding:'utf8'});assert.notEqual(denied.status,0);assert.equal(await readFile(log,'utf8'),commands);
 }finally{await rm(dir,{recursive:true,force:true});}
});
