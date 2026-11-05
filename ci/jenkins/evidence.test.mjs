import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm,mkdir,writeFile,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from './ci.mjs';
import { collectEvidence,summarizeTests } from './evidence.mjs';
test('a real failed test preserves useful bounded evidence while redacting credentials',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'j5-evidence-'));
 try{
  const r=await runCommand([process.execPath,'-e',"console.log('test failed: expected 2 got 3\\ntoken=super-sensitive-value\\n# pass 0\\n# fail 1');process.exit(1)"],{output:dir,redactions:['super-sensitive-value']});
  const log=await readFile(join(dir,'stdout.log'),'utf8');assert.equal(r.exitCode,1);assert.match(log,/expected 2 got 3/);assert.doesNotMatch(log,/super-sensitive-value/);
  const evidence=await collectEvidence({id:'unit-integration',output:dir,cwd:dir,execution:r});
  assert.equal(evidence.tests.failed,1);assert.equal(evidence.tests.passed,0);assert.ok(evidence.artifacts.some(a=>a.path==='stdout.log'&&a.sha256.length===64));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('screenshots are required for UI completeness and symlinks are never collected',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'j5-screens-'));
 try{
  await writeFile(join(dir,'stdout.log'),'2 passed (1s)');await writeFile(join(dir,'stderr.log'),'');
  const first=await collectEvidence({id:'ui-acceptance',output:dir,cwd:dir,execution:{}});assert.equal(first.complete,false);
  await mkdir(join(dir,'apps/ui/test-results/screenshots'),{recursive:true});
  await symlink('/etc/hosts',join(dir,'apps/ui/test-results/screenshots/fake.png'));
  const second=await collectEvidence({id:'ui-acceptance',output:dir,cwd:dir,execution:{}});assert.equal(second.complete,false);
  await writeFile(join(dir,'apps/ui/test-results/screenshots/safe.png'),Buffer.from('fixture-image'));
  const third=await collectEvidence({id:'ui-acceptance',output:dir,cwd:dir,execution:{}});assert.equal(third.complete,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('structured Go test events count test cases rather than packages',()=>{
 assert.deepEqual(summarizeTests('{"Action":"pass","Test":"TestOne"}\n{"Action":"fail","Test":"TestTwo"}\n{"Action":"pass","Package":"example"}'),{passed:1,failed:1,skipped:0,known:true});
});
test('image scan cannot be complete without conditional Kong candidate evidence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'j5-candidate-evidence-'));
 try{await writeFile(join(dir,'stdout.log'),'scan completed');await writeFile(join(dir,'stderr.log'),'');
  assert.equal((await collectEvidence({id:'image-scan',output:dir,cwd:dir,execution:{}})).complete,false);
  await writeFile(join(dir,'kong-candidate.json'),JSON.stringify({schema:'gromesh-kong-candidate/v1',required:true,passed:false}));await writeFile(join(dir,'kong-candidate.log'),'smoke failed');
  assert.equal((await collectEvidence({id:'image-scan',output:dir,cwd:dir,execution:{}})).complete,false);
  await writeFile(join(dir,'kong-candidate.json'),JSON.stringify({schema:'gromesh-kong-candidate/v1',required:false,passed:null}));
  assert.equal((await collectEvidence({id:'image-scan',output:dir,cwd:dir,execution:{}})).complete,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('runtime-generated child credentials are redacted using the private per-run secret list',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'j5-generated-secret-'));const state=join(dir,'state');await mkdir(state,{mode:0o700});
 try{const code="require('node:fs').writeFileSync(process.env.GROMESH_CI_STATE+'/redactions.txt','test-only-generated-value\\n',{mode:0o600});console.log('actual failure: test-only-generated-value');process.exit(1)";
  await runCommand([process.execPath,'-e',code],{env:{PATH:process.env.PATH,GROMESH_CI_STATE:state},output:join(dir,'logs')});
  const text=await readFile(join(dir,'logs/stdout.log'),'utf8');assert.match(text,/actual failure/);assert.doesNotMatch(text,/test-only-generated-value/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
