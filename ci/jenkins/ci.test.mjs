import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, runStage } from './ci.mjs';

test('records the actual exit status without leaking process output', async () => {
  const r = await runCommand([process.execPath, '-e', "console.log('DO_NOT_STORE_SECRET');process.exit(7)"], { timeoutMs: 10000 });
  assert.equal(r.exitCode, 7);
  assert.equal(r.status, 'FAILURE');
  assert.equal(JSON.stringify(r).includes('DO_NOT_STORE_SECRET'), false);
});
test('executes argv literally and does not interpret shell metacharacters', async () => {
  const r = await runCommand([process.execPath, '-e', 'if(process.argv[1]!=="$(exit 9)")process.exit(3)', '$(exit 9)'], { timeoutMs: 10000 });
  assert.equal(r.exitCode, 0);
});
test('timeout terminates a real private process group and its descendant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gromesh-j5-cancel-'));
  const ready = join(dir, 'ready'), marker = join(dir, 'survived');
  const child = `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad'),1500)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  try {
    const pending = runCommand([process.execPath, '-e', parent], { timeoutMs: 700, terminationGraceMs: 100 });
    const deadline = Date.now()+600;
    while (Date.now()<deadline) { try { await access(ready); break; } catch { await new Promise(r => setTimeout(r,10)); } }
    await access(ready);
    const result = await pending;
    assert.equal(result.status, 'TIMED_OUT');
    await new Promise(r => setTimeout(r,1700));
    await assert.rejects(access(marker));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('external cancellation prevents a pending command from starting', async () => {
  const controller = new AbortController(); controller.abort();
  const r = await runCommand([process.execPath, '-e', 'process.exit(9)'], { signal: controller.signal });
  assert.equal(r.status, 'ABORTED'); assert.equal(r.started, false);
});
test('unknown stages refuse before any execution', async () => {
  await assert.rejects(runStage('shell-from-pr', { cwd: process.cwd(), output: '/nonexistent' }), /stage/i);
});
test('an unavailable executable is a failed result, never success', async () => {
  const r = await runCommand(['/definitely/not/a/program'], { timeoutMs: 1000 });
  assert.equal(r.status, 'FAILURE'); assert.notEqual(r.exitCode, 0);
});
test('nested command cancellation with default grace cannot orphan an independently TERM-resistant descendant',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'gromesh-j5-nested-')),marker=join(dir,'survived');
 const child=`process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad'),5700);setTimeout(()=>process.exit(0),6400)`;
 const wrapper=`import {runCommand} from ${JSON.stringify(new URL('./ci.mjs',import.meta.url).href)};const c=new AbortController();process.on('SIGTERM',()=>c.abort());await runCommand([process.execPath,'-e',${JSON.stringify(child)}],{signal:c.signal,timeoutMs:30000});`;
 try{
  const result=await runCommand([process.execPath,'--input-type=module','-e',wrapper],{timeoutMs:250});
  assert.equal(result.status,'TIMED_OUT');await new Promise(r=>setTimeout(r,900));await assert.rejects(access(marker));
 }finally{await new Promise(r=>setTimeout(r,500));await rm(dir,{recursive:true,force:true});}
});
