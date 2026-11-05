import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createReceipt,authorizePlan,J5_POLICY } from './approval.mjs';
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const plan=()=>({schema:'gromesh-cd-plan/v1',environment:'DEV',requester:'requester',job:'gromesh-gateway/gromesh-dev/gromesh-dev',buildId:'10',nonce:'a'.repeat(32),issuedAt:'2026-11-05T01:00:00Z',expiresAt:'2026-11-05T01:30:00Z',sourceSha:'a'.repeat(40),releaseHash:'b'.repeat(64),changes:[{image:'repo@sha256:'+'a'.repeat(64)}]});
const policy={allowedApprovers:['admin-a','admin-b'],signingKey:{privateKey,keyId:'approval-2026'},verificationKey:{publicKey,keyId:'approval-2026'}};
test('a receipt signs the exact plan and real authenticated approver identities',()=>{
 const p=plan(),r=createReceipt(p,{submitters:['admin-a'],authentication:'JENKINS_INPUT_SUBMITTER'},policy,Date.parse('2026-11-05T01:05:00Z'));
 assert.equal(authorizePlan(p,r,policy,{now:Date.parse('2026-11-05T01:05:00Z'),consumedNonces:new Set()}).planHash.length,64);
 p.changes[0].image+='x';assert.throws(()=>authorizePlan(p,r,policy,{now:Date.parse('2026-11-05T01:05:00Z'),consumedNonces:new Set()}));
});
test('requester, repeated PRD approver, forged identities, expired approval and replay are refused',()=>{
 for(const submitters of [['requester'],['admin-a','admin-a'],['foreign']])assert.throws(()=>createReceipt({...plan(),environment:'PRD'},{submitters,authentication:'JENKINS_INPUT_SUBMITTER'},policy,Date.parse('2026-11-05T01:05:00Z')));
 assert.throws(()=>createReceipt(plan(),{submitters:['admin-a'],authentication:'BUILD_PARAMETER'},policy,Date.parse('2026-11-05T01:05:00Z')));
 const p=plan(),r=createReceipt(p,{submitters:['admin-a'],authentication:'JENKINS_INPUT_SUBMITTER'},policy,Date.parse('2026-11-05T01:05:00Z'));
 assert.throws(()=>authorizePlan(p,r,policy,{now:Date.parse('2026-11-05T02:00:00Z'),consumedNonces:new Set()}));
 assert.throws(()=>authorizePlan(p,r,policy,{now:Date.parse('2026-11-05T01:05:00Z'),consumedNonces:new Set([p.nonce])}));
 assert.equal(J5_POLICY.applyEnabled,false);assert.equal(J5_POLICY.hmlEnabled,false);assert.equal(J5_POLICY.prdEnabled,false);
});
