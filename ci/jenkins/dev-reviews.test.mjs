import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDevAccess,devReview } from './dev-reviews.mjs';
const target={apiServer:'https://dev.invalid:6443',namespace:'gateway',release:'gromesh',deployment:'gromesh-control-plane-ui'};
test('DEV authorization checks require exact UI rights and deny unrelated workloads, CP and cluster privileges',async()=>{
 for(const role of ['plan','apply']){
  const seen=[];
  const review=async(_connection,_target,type,{resourceAttributes:q})=>{seen.push(q);assert.equal(type,'access');return {status:{allowed:q.verb==='get'&&q.resource==='deployments'||role==='apply'&&q.verb==='patch'&&q.name===target.deployment}};};
  await checkDevAccess({},target,role,review);assert.equal(seen.length,8);
  assert.ok(seen.some(q=>q.name==='gromesh-control-plane'&&q.verb==='patch'));
 }
 await assert.rejects(checkDevAccess({},target,'plan',async()=>({status:{allowed:true}})),/privilege/);
 await assert.rejects(checkDevAccess({},target,'plan',async()=>({status:{allowed:false}})),/privilege/);
 await assert.rejects(checkDevAccess({},target,'plan',async()=>({status:{allowed:true,evaluationError:'partial authorization failure'}})),/privilege/);
});
test('DEV identity review cannot redirect credentials to a non-pinned route or plaintext endpoint',()=>{
 for(const apiServer of ['http://dev.invalid:6443','https://user@dev.invalid','https://dev.invalid/x','https://dev.invalid/?redirect=x'])
  assert.throws(()=>devReview({}, {...target,apiServer},'identity'),/Pinned API/);
 assert.throws(()=>devReview({},target,'workload-write'),/Pinned API/);
});
