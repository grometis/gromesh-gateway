import test from 'node:test';
import assert from 'node:assert/strict';
import { planDiscovery, acknowledgeDiscovery } from './discovery.mjs';
const main=()=>({repository:'grometis/gromesh-gateway',sha:'a'.repeat(40),event:'push',branch:'main',pr:null,baseSha:null});
const pr=()=>({repository:'grometis/gromesh-gateway',sha:'b'.repeat(40),event:'pull_request',branch:'feature/ci',pr:300,baseSha:'a'.repeat(40)});
const empty=()=>({schema:'gromesh-jenkins-discovery/v1',fingerprints:{}});
test('queues the main and PR once without duplicating the same branch CI',()=>{
  const branch={...main(),sha:'b'.repeat(40),branch:'feature/ci'};
  const p=planDiscovery([main(),pr(),branch],empty());
  assert.deepEqual(p.pending.map(x=>x.job),['gromesh-gateway/gromesh-ci/gromesh-main','gromesh-gateway/gromesh-ci/gromesh-prs']);
  assert.equal(p.coveredBranches,1);
});
test('only an acknowledged source is remembered, and changed PR base runs again',()=>{
  let state=acknowledgeDiscovery(empty(),main());
  assert.deepEqual(planDiscovery([main(),pr()],state).pending.map(x=>x.source.pr),[300]);
  state=acknowledgeDiscovery(state,pr());assert.equal(planDiscovery([main(),pr()],state).pending.length,0);
  assert.equal(planDiscovery([main(),{...pr(),baseSha:'c'.repeat(40)}],state).pending.length,1);
});
test('caps dispatch batch size without claiming that remaining sources were dispatched',()=>{
  const sources=Array.from({length:25},(_,i)=>({...pr(),pr:i+1}));
  const p=planDiscovery(sources,empty());assert.equal(p.pending.length,20);assert.equal(p.remaining,5);
  assert.equal(Object.keys(empty().fingerprints).length,0);
});
test('candidate data cannot select a deployment job or another repository',()=>{
  const p=planDiscovery([{...pr(),job:'gromesh-gateway/gromesh-dev/gromesh-deploy'}],empty());
  assert.equal(p.pending[0].job,'gromesh-gateway/gromesh-ci/gromesh-prs');
  assert.throws(()=>planDiscovery([{...pr(),repository:'attacker/repo'}],empty()));
});
test('invalid saved state fails closed rather than causing a full duplicate CI storm',()=>{
  assert.throws(()=>planDiscovery([main()],{schema:'other',fingerprints:{}}));
  assert.throws(()=>planDiscovery([main()],{schema:'gromesh-jenkins-discovery/v1',fingerprints:{'branch:main':'not-a-hash'}}));
});
