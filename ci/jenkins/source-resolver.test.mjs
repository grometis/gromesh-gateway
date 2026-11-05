import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSource } from './source-resolver.mjs';
const head='a'.repeat(40),base='b'.repeat(40),merge='c'.repeat(40);
test('authenticated source resolution binds a canonical PR merge to the actual head and base parents',async()=>{
 const calls=[];const client={api:async path=>{calls.push(path);return path.startsWith('/pulls/')?{state:'open',number:1,head:{sha:head,ref:'feature'},base:{sha:base,repo:{full_name:'grometis/gromesh-gateway'}},mergeable:true,merge_commit_sha:merge}:{sha:merge,parents:[{sha:head},{sha:base}]};}};
 const result=await resolveSource(client,{profile:'pr',sha:head,pr:'1',fromDiscovery:false});assert.equal(result.source.sha,merge);assert.equal(result.source.headSha,head);assert.equal(result.comparisonBase,base);assert.deepEqual(calls,['/pulls/1','/commits/'+merge]);
});
test('foreign PR bases or stale merge parents never produce a publishable source',async()=>{
 const pr={state:'open',number:1,head:{sha:head,ref:'feature'},base:{sha:base,repo:{full_name:'foreign/repository'}},mergeable:true,merge_commit_sha:merge};
 await assert.rejects(resolveSource({api:async()=>pr},{profile:'pr',sha:head,pr:'1'}));
 pr.base.repo.full_name='grometis/gromesh-gateway';await assert.rejects(resolveSource({api:async p=>p.startsWith('/pulls/')?pr:{sha:merge,parents:[{sha:head},{sha:'d'.repeat(40)}]}},{profile:'pr',sha:head,pr:'1'}));
});
