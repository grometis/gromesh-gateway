import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { executeNativeBuild } from './image-pipeline.mjs';
test('a mismatched source SHA never executes a build or scanner',async()=>{
 let calls=0;await assert.rejects(executeNativeBuild({component:'ui',sha:'a'.repeat(40),pipelineSha:'b'.repeat(40),architecture:'arm64',worker:{policy:{role:'image-builder',pipelineSha:'b'.repeat(40)},facts:{architecture:'arm64'}},checkedOutSha:'c'.repeat(40),execute:async()=>calls++}),/SHA|source/i);assert.equal(calls,0);
});
test('the image CLI refuses this Mac without invoking heavy tools or accepting operator credentials',()=>{
 const r=spawnSync(process.execPath,[fileURLToPath(new URL('./image-pipeline.mjs',import.meta.url)),'build','ui'],{env:{PATH:process.env.PATH,HOME:process.env.HOME,GH_TOKEN:'fixture-only'},encoding:'utf8'});
 assert.equal(r.status,78);assert.match(r.stdout,/WORKER_NOT_QUALIFIED/);assert.doesNotMatch(r.stdout,/fixture-only/);
});
