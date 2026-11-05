import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHubDigest } from './hub.mjs';
import { byteDigest } from './registry.mjs';
test('anonymous Hub lookup hashes returned manifest bytes and limits the pull scope to the selected repository',async()=>{
 const raw=Buffer.from('{"schemaVersion":2}'),calls=[];
 const d=await resolveHubDigest('ui','sha-'+'a'.repeat(40),{transport:async(url,opts)=>{calls.push({url,opts});return url.startsWith('https://auth.docker.io/')?new Response(JSON.stringify({token:'fixture-anonymous'})):new Response(raw,{headers:{'docker-content-digest':byteDigest(raw)}});}});
 assert.equal(d,byteDigest(raw));assert.match(calls[0].url,/repository%3Afabriciobackend%2Fgromesh-ui%3Apull/);assert.equal(calls.length,2);
});
test('only authenticated registry 404 means missing; outage and wrong digest are errors',async()=>{
 for(const status of [401,403,429,500])await assert.rejects(resolveHubDigest('ui','sha-'+'a'.repeat(40),{transport:async url=>url.includes('auth.docker.io')?new Response('{"token":"fixture"}'):new Response('',{status})}));
 const missing=await resolveHubDigest('ui','sha-'+'a'.repeat(40),{transport:async url=>url.includes('auth.docker.io')?new Response('{"token":"fixture"}'):new Response('',{status:404})});assert.equal(missing,null);
});
