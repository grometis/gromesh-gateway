import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStage } from './ci.mjs';

test('generated-client runs generation and rejects a dirty generated API', async () => {
  const dir=await mkdtemp(join(tmpdir(),'gromesh-j5-stage-'));
  const log=join(dir,'commands');
  try {
    for(const [name,exit] of [['pnpm',0],['git',3]]) {
      const p=join(dir,name);await writeFile(p,`#!/bin/sh\nprintf '%s\\n' "$*" >> "$COMMAND_LOG"\nexit ${exit}\n`);await chmod(p,0o700);
    }
    const result=await runStage('generated-client',{cwd:dir,output:join(dir,'results'),env:{PATH:dir+':/usr/bin:/bin',COMMAND_LOG:log}});
    assert.equal(result.status,'FAILURE');assert.equal(result.exitCode,3);
    assert.equal(await readFile(log,'utf8'),'--filter @gromesh/ui gen:api\ndiff --exit-code -- apps/ui/src/api/schema.d.ts apps/ui/src/api/schema-v2.d.ts\n');
    const saved=JSON.parse(await readFile(join(dir,'results/generated-client.json'),'utf8'));
    assert.equal(saved.status,'FAILURE');
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('integration refuses an operational Docker endpoint before starting database containers', async () => {
  const dir=await mkdtemp(join(tmpdir(),'gromesh-j5-infra-'));
  const marker=join(dir,'docker-executed');
  try {
    const p=join(dir,'docker');await writeFile(p,`#!/bin/sh\ntouch "$MARKER"\n`);await chmod(p,0o700);
    const result=await runStage('unit-integration',{cwd:dir,output:join(dir,'results'),env:{PATH:dir+':/usr/bin:/bin',MARKER:marker,JENKINS_URL:'https://jenkins.grometis.com/',DOCKER_HOST:'tcp://192.168.15.3:2375',GROMESH_CI_RUN:'a'.repeat(32)}});
    assert.equal(result.status,'FAILURE');
    assert.equal(result.exitCode,78);
    await assert.rejects(readFile(marker));
  } finally { await rm(dir,{recursive:true,force:true}); }
});
