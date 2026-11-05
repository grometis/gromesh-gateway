import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { DeliveryApp,deliveryPlan } from './delivery-app.mjs';
test('delivery App mints a one-repository token with contents/PR write only; no checks/admin/org grants',async()=>{
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});const calls=[];
 const app=new DeliveryApp({appId:'12',installationId:'34',privateKey,transport:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(url.endsWith('/access_tokens')?{token:'fixture-only',expires_at:new Date(Date.now()+3600000).toISOString()}:{number:123}));}});
 const p=deliveryPlan({branch:'task/J5-A-jenkins-ci',sha:'a'.repeat(40),base:'main',title:'J5 A',body:'Prepared local CI; no deploy.'});
 await app.createPr(p);
 const tokenRequest=JSON.parse(calls[0].options.body);assert.deepEqual(tokenRequest.repository_ids,[1421583751]);assert.deepEqual(tokenRequest.permissions,{metadata:'read',contents:'write',pull_requests:'write'});
 assert.equal(calls[1].url,'https://api.github.com/repos/grometis/gromesh-gateway/pulls');assert.equal(JSON.parse(calls[1].options.body).draft,true);
 assert.throws(()=>deliveryPlan({branch:'main',sha:'a'.repeat(40),base:'main',title:'oops',body:'x'}));
 assert.throws(()=>deliveryPlan({branch:'task/other-project',sha:'a'.repeat(40),base:'main',title:'oops',body:'x'}));
});
