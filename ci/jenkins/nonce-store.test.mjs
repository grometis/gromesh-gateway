import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,realpath,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NonceStore } from './nonce-store.mjs';
test('durable exclusive reservations reject simultaneous receipt reuse without deleting prior evidence',async()=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'j5-nonce-')));
 try{const store=new NonceStore(dir),nonce='a'.repeat(32),hash='b'.repeat(64);
  const r=await Promise.allSettled([store.reserve(nonce,hash),store.reserve(nonce,hash)]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal((await store.read()).has(nonce),true);
  await assert.rejects(store.reserve(nonce,hash));await assert.rejects(store.reserve('../outside',hash));
 }finally{await rm(dir,{recursive:true,force:true});}
});
