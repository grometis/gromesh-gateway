import {createHmac} from 'node:crypto';
import {expect,it} from 'vitest';
import {BatchIdentityPolicy} from './batch-identity.js';
const sign=(value:string)=>createHmac('sha256','synthetic-only-test-key').update(value).digest('hex');
const policy=new BatchIdentityPolicy(sign),now=Date.parse('2026-01-01T00:00:00Z');
const context={instanceId:'00000000-0000-4000-8000-000000000001',streamId:'00000000-0000-4000-8000-000000000002',authorizationId:'00000000-0000-4000-8000-000000000003',descriptorDigest:'a'.repeat(64)};
it('issues repeatable authenticated identities bound to stream content authorization and position',()=>{
 const issued=policy.issue({...context,position:'12'},now);expect(issued).toEqual(policy.issue({...context,position:'12'},now));
 expect(policy.verify(issued.token,{...context,batchId:issued.batchId},now+1).position).toBe('12');
 expect(issued.batchId[14]).toBe('8');
});
it.each(['instanceId','streamId','authorizationId','descriptorDigest'] as const)('rejects altered %s without preserving payload or an infinite UUID registry',key=>{
 const ticket=policy.issue({...context,position:'1'},now);expect(()=>policy.verify(ticket.token,{...context,[key]:key==='descriptorDigest'?'b'.repeat(64):'00000000-0000-4000-8000-000000000009',batchId:ticket.batchId},now)).toThrow();
});
it('rejects exact expiration, future issue time, malformed tokens and another handle',()=>{
 const t=policy.issue({...context,position:'1'},now);
 for(const time of [now-1,now+900000])expect(()=>policy.verify(t.token,{...context,batchId:t.batchId},time)).toThrow();
 for(const token of ['',t.token+'a','a'.repeat(2049)])expect(()=>policy.verify(token,{...context,batchId:t.batchId},now)).toThrow();
 expect(()=>policy.verify(t.token,{...context,batchId:context.streamId},now)).toThrow();
});
it('does not reuse a handle for another position or contents and survives process recreation',()=>{
 const a=policy.issue({...context,position:'1'},now),b=policy.issue({...context,position:'2'},now);
 expect(a.batchId).not.toBe(b.batchId);expect(new BatchIdentityPolicy(sign).verify(a.token,{...context,batchId:a.batchId},now).position).toBe('1');
});
it.each(['0','-1','01','9223372036854775808'])('rejects an invalid or overflowing position %s',position=>{expect(()=>policy.issue({...context,position},now)).toThrow();});
