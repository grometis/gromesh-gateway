import test from 'node:test';
import assert from 'node:assert/strict';
import { collectPublisherState,assertOfficialCutover } from './actions-state.mjs';
const sha='a'.repeat(40),now=Date.now();
test('official publisher refuses active Actions, queued runs, missing authorization and stale ownership evidence',async()=>{
 const transport=async url=>new Response(JSON.stringify(url.includes('/runs?')?{total_count:0,workflow_runs:[]}:{id:11,state:'disabled_manually'}));
 const state=await collectPublisherState({transport,now});
 const cutover={pipelineSha:sha,authorizedBy:'owner',authorizedAt:new Date(now-1000).toISOString(),authorizationId:'J5-operator-cutover',approved:true};
 assert.doesNotThrow(()=>assertOfficialCutover({cutover,state,pipelineSha:sha,now}));
 for(const alter of [x=>x.cutover.approved=false,x=>x.cutover.pipelineSha='b'.repeat(40),x=>x.state.workflows[0].state='active',x=>x.state.workflows[0].activeRuns=1,x=>x.state.observedAt=new Date(now-60001).toISOString()]){
  const x=structuredClone({cutover,state,pipelineSha:sha,now});alter(x);assert.throws(()=>assertOfficialCutover(x));
 }
 await assert.rejects(collectPublisherState({transport:async()=>new Response('{}',{status:403}),now}));
 const busy=await collectPublisherState({transport:async url=>new Response(JSON.stringify(url.includes('/runs?')?{total_count:1,workflow_runs:[{path:'.github/workflows/images.yml'}]}:{state:'disabled_manually'})),now});
 assert.throws(()=>assertOfficialCutover({cutover,state:busy,pipelineSha:sha,now}));
 await assert.rejects(collectPublisherState({transport:async url=>new Response(JSON.stringify(url.includes('/runs?')?{total_count:101,workflow_runs:[]}:{state:'disabled_manually'})),now}));
});
test('assembly plus all five publisher ownership collections fit a fresh anonymous 60-request budget',async()=>{
 let calls=0;
 const transport=async url=>{calls++;if(calls>60)return new Response('{}',{status:429});return new Response(JSON.stringify(url.includes('/runs?')?{total_count:0,workflow_runs:[]}:{id:1,state:'disabled_manually'}));};
 for(let i=0;i<6;i++)await collectPublisherState({transport,now});
 assert.ok(calls<=48,'Six complete ownership reads must stay within 48 requests, leaving headroom');
});
