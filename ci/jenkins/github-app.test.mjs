import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { appJwt, GitHubApp } from './github-app.mjs';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
test('GitHub App JWT has a bounded lifetime and a genuine RSA signature', () => {
  const now = 1800000000;
  const token = appJwt('123', privateKey, now);
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header,'base64url')), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(payload,'base64url'));
  assert.equal(claims.iss, '123'); assert.ok(claims.exp <= now+600); assert.ok(claims.iat <= now);
  assert.ok(verify('RSA-SHA256', Buffer.from(header+'.'+payload), publicKey, Buffer.from(signature,'base64url')));
});
test('installation tokens are requested for only the Gateway repository and required permissions', async () => {
  const calls = [];
  const client = new GitHubApp({ appId:'123', installationId:'456', privateKey,
    transport: async (url, options) => { calls.push({ url, options }); return { ok:true, status:201, json: async()=>({ token:'fixture-only', expires_at:'2099-01-01T00:00:00Z' }) }; } });
  await client.installationToken();
  assert.equal(calls[0].url, 'https://api.github.com/app/installations/456/access_tokens');
  assert.deepEqual(JSON.parse(calls[0].options.body), { repositories:['gromesh-gateway'], permissions:{ contents:'read', metadata:'read', pull_requests:'read', checks:'write' } });
});
test('a failed installation request never becomes an anonymous or shared-token fallback', async () => {
  const client = new GitHubApp({ appId:'123', installationId:'456', privateKey,
    transport: async()=>({ ok:false, status:403 }) });
  await assert.rejects(client.installationToken(), /403/);
});
test('checks are attached to the exact SHA with the official Jenkins URL', async () => {
  const requests=[];
  const client = new GitHubApp({ appId:'123', installationId:'456', privateKey,
    transport: async(url,options)=>{ requests.push({ url,options }); return { ok:true,status:201,json:async()=> url.includes('access_tokens') ? {token:'fixture-only',expires_at:'2099-01-01T00:00:00Z'} : {id:101} }; } });
  await client.check({ sha:'a'.repeat(40), buildUrl:'https://jenkins.grometis.com/job/gromesh-gateway/job/gromesh-ci/job/gromesh-main/17/', externalId:'main:17', conclusion:'failure', summary:'Required stage did not run' });
  const body=JSON.parse(requests.at(-1).options.body);
  assert.equal(body.head_sha,'a'.repeat(40));assert.equal(body.name,'jenkins-ci-main');assert.equal(body.conclusion,'failure');
  assert.equal(requests.at(-1).url,'https://api.github.com/repos/grometis/gromesh-gateway/check-runs');
  await assert.rejects(client.check({ sha:'bad', buildUrl:'http://localhost:18081', externalId:'x', conclusion:'success', summary:'x' }));
});
test('discovery paginates PRs and uses canonical PR refs rather than attacker clone URLs', async () => {
  const first=Array.from({length:100},(_,i)=>({number:i+1,state:'open',head:{sha:'a'.repeat(40),ref:'feature',repo:{full_name:'attacker/fork'}},base:{sha:'b'.repeat(40),ref:'main',repo:{full_name:'grometis/gromesh-gateway'}}}));
  const client = new GitHubApp({ appId:'123', installationId:'456', privateKey,
    transport:async url=>({ok:true,status:200,json:async()=>url.includes('access_tokens')?{token:'fixture-only',expires_at:'2099-01-01T00:00:00Z'}:url.includes('/branches/main')?{commit:{sha:'c'.repeat(40)}}:url.includes('/branches?')?[]:url.endsWith('page=1')?first:[]}) });
  const sources=await client.discover();
  assert.equal(sources.length,101);
  assert.equal(sources[1].checkoutRef,'refs/pull/1/head');
  assert.equal(sources[1].repository,'grometis/gromesh-gateway');
  assert.equal(JSON.stringify(sources).includes('attacker/fork'),false);
});
test('discovery also finds non-main branches without granting publication trust',async()=>{
  const client=new GitHubApp({appId:'123',installationId:'456',privateKey,transport:async url=>({ok:true,status:200,json:async()=>url.includes('access_tokens')?{token:'fixture-only',expires_at:'2099-01-01T00:00:00Z'}:url.includes('/branches/main')?{commit:{sha:'a'.repeat(40)}}:url.includes('/branches?')?[{name:'feature/ci',commit:{sha:'b'.repeat(40)}}]:[]})});
  const sources=await client.discover();assert.equal(sources.length,2);assert.equal(sources[1].checkoutRef,'refs/heads/feature/ci');assert.equal(sources[1].branch,'feature/ci');
});
