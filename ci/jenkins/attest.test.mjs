import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { attestCi } from './attest.mjs';
test('CI signer refuses incomplete reports and PR sources even with a signing key',()=>{
 const {privateKey}=generateKeyPairSync('ed25519');
 for(const source of [{repository:'grometis/gromesh-gateway',sha:'a'.repeat(40),branch:'main',event:'push',pr:null,baseSha:null},{repository:'grometis/gromesh-gateway',sha:'a'.repeat(40),branch:'main',event:'pull_request',pr:1,baseSha:'c'.repeat(40)}])
  assert.throws(()=>attestCi({source,stages:[]},{source,pipelineSha:'b'.repeat(40),job:'gromesh-gateway/gromesh-ci/gromesh-main',buildId:'1'},{privateKey,keyId:'ci-2026'},Date.now()));
});
