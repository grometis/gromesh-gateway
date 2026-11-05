import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalHash} from './policy.mjs';
import {artifactStoragePlan,validateArtifactManifest,verifyStoredBytes} from './artifact-storage.mjs';
import {startFixture} from './test-fixtures/artifact-http.mjs';
const bytes=Buffer.from('fixture OCI bytes\0not an image'),sha='a'.repeat(40),pipeline='b'.repeat(40),now=Date.parse('2026-11-05T20:00:00Z');
const source={repository:'grometis/gromesh-gateway',sha,branch:'main',event:'push',pr:null,baseSha:null};
const context=()=>({source,pipelineSha:pipeline,job:'gromesh-artifacts/gromesh-images',buildId:'1',prefix:'jenkins-gromesh/oci/',consumer:'publisher',allowedConsumers:['publisher'],maximumBytes:1024*1024,quotaBytes:8*1024*1024,usedBytes:0,now,maximumRetentionMs:86400000});
const manifest=()=>({schema:'gromesh-stored-artifact/v1',source,pipelineSha:pipeline,job:'gromesh-artifacts/gromesh-images',buildId:'1',key:`jenkins-gromesh/oci/${pipeline}/${sha}/1/amd64.tar`,bytes:bytes.length,digest:'sha256:'+createHash('sha256').update(bytes).digest('hex'),createdAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60000).toISOString(),retentionClass:'scratch'});
test('official backend plan is inactive and never treats fixture as qualification',()=>{const p=artifactStoragePlan({prefix:'jenkins-gromesh/',maximumObjectGiB:20,retainedRuns:10});assert.equal(p.provider,'artifact-manager-s3');assert.equal(p.enabled,false);assert.equal(p.qualified,false);assert.equal(p.consoleLogsOffloaded,false);assert.equal(p.backendQuotaEnforced,false);assert.equal(p.maximumObjectBytes,20*2**30);assert.ok(p.blockers.includes('REAL_JENKINS_ARCHIVE_STASH_COPYARTIFACT'));});
test('manifest binds consumer, source, pipeline, build, key, size and digest',()=>{assert.equal(validateArtifactManifest(manifest(),context()).identity,canonicalHash(manifest()));assert.equal(verifyStoredBytes(manifest(),bytes).verified,true);});
for(const [name,mutate]of[
 ['repository',m=>m.source={...source,repository:'other/project'}],['SHA',m=>m.source={...source,sha:'c'.repeat(40)}],['pipeline',m=>m.pipelineSha='d'.repeat(40)],['job',m=>m.job='other/job'],['build',m=>m.buildId='2'],['prefix',m=>m.key='foreign/key'],['traversal',m=>m.key=m.key.replace('amd64.tar','../secret')],['encoded path',m=>m.key=m.key.replace('amd64.tar','%2e%2e')],['digest',m=>m.digest='md5:abc'],['oversize',m=>m.bytes=1024*1024+1],['negative size',m=>m.bytes=-1],['expiry',m=>m.expiresAt=new Date(now-1).toISOString()],['retention',m=>m.expiresAt=new Date(now+2*86400000).toISOString()],['future',m=>m.createdAt=new Date(now+1000).toISOString()],['release implicit expiry',m=>m.retentionClass='release']
])test('manifest refuses '+name,()=>{const m=manifest();mutate(m);assert.throws(()=>validateArtifactManifest(m,context()),/artifact refused/i);});
for(const [name,mutate]of[['consumer',c=>c.consumer='pr'],['quota',c=>c.usedBytes=c.quotaBytes],['quota NaN',c=>c.quotaBytes=NaN],['missing source authority',c=>delete c.source]])test('trusted context refuses '+name,()=>{const c=context();mutate(c);assert.throws(()=>validateArtifactManifest(manifest(),c),/artifact refused/i);});
test('integrity rejects partial and same-size tampered bytes',()=>{assert.throws(()=>verifyStoredBytes(manifest(),bytes.subarray(1)),/artifact refused/i);assert.throws(()=>verifyStoredBytes(manifest(),Buffer.alloc(bytes.length)),/artifact refused/i);});
test('loopback fixture transfers bytes, refuses scope/quota and recovers after partial object',async t=>{const f=await startFixture();t.after(()=>f.close());const m=manifest(),headers={authorization:f.authorization};const url=f.origin+'/object';
 assert.equal((await fetch(url,{method:'PUT',headers,body:bytes})).status,201);const received=Buffer.from(await(await fetch(url,{headers})).arrayBuffer());assert.deepEqual(received,bytes);verifyStoredBytes(m,received);
 assert.equal((await fetch(url)).status,403);assert.equal((await fetch(f.origin+'/elsewhere',{headers})).status,403);
 assert.equal((await fetch(url,{method:'PUT',headers,body:Buffer.alloc(1024*1024+1)})).status,413);
 await fetch(url,{method:'PUT',headers,body:bytes.subarray(2)});assert.throws(()=>verifyStoredBytes(m,bytes.subarray(2)),/artifact refused/i);
 await fetch(url,{method:'PUT',headers,body:bytes});verifyStoredBytes(m,Buffer.from(await(await fetch(url,{headers})).arrayBuffer()));
 await fetch(url,{method:'PUT',headers,body:Buffer.alloc(bytes.length)});assert.throws(()=>verifyStoredBytes(m,Buffer.alloc(bytes.length)),/artifact refused/i);
 assert.equal((await fetch(url,{method:'DELETE',headers})).status,204);assert.equal((await fetch(url,{headers})).status,404);
 await f.close();await assert.rejects(fetch(url,{headers}));assert.ok(f.transferredBytes<=8*1024*1024);
});
test('fixture enforces a hard cumulative quota without large allocations',async t=>{const f=await startFixture({maximumObjectBytes:64,quotaBytes:128});t.after(()=>f.close());const h={authorization:f.authorization};for(let i=0;i<2;i++)assert.equal((await fetch(f.origin+'/object',{method:'PUT',headers:h,body:Buffer.alloc(64)})).status,201);assert.equal((await fetch(f.origin+'/object',{method:'PUT',headers:h,body:Buffer.alloc(1)})).status,507);});

test('real aborted transport preserves the last object and permits a recovery PUT/GET',async()=>{
 const url=new URL('./test-fixtures/artifact-http.mjs',import.meta.url).href;
 const code=`import{startFixture}from ${JSON.stringify(url)};import http from 'node:http';import assert from 'node:assert/strict';import{setTimeout}from'node:timers/promises';
 const f=await startFixture();const headers={authorization:f.authorization};const url=f.origin+'/object';
 await fetch(url,{method:'PUT',headers,body:'last-complete-object'});
 const req=http.request(url,{method:'PUT',headers:{...headers,'content-length':'64'}});req.on('error',()=>{});req.write(Buffer.from('short'));await setTimeout(40);req.destroy();await setTimeout(80);
 assert.equal(await(await fetch(url,{headers})).text(),'last-complete-object');
 assert.equal((await fetch(url,{method:'PUT',headers,body:'recovery'})).status,201);assert.equal(await(await fetch(url,{headers})).text(),'recovery');await f.close();`;
 const result=await promisify(execFile)(process.execPath,['--max-old-space-size=64','--input-type=module','-e',code],{timeout:10000,maxBuffer:16384});assert.equal(result.stderr,'');
});
