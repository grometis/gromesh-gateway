import test from 'node:test';
import assert from 'node:assert/strict';
import { semanticScopedPlan } from './cd.mjs';
import { canonicalHash } from './policy.mjs';
test('revalidation tolerates only transient credential/chart locations and preserves cluster, image and rendered-byte changes',()=>{
 const p={renderProof:{scope:{kubeconfig:'/private/read-credential'},chart:'/worker-one/source/chart',chartSha256:'a'.repeat(64)},command:{args:['--kubeconfig','/private/read-credential','/worker-one/source/chart',JSON.stringify({scope:{kubeconfig:'/private/read-credential'}})]},cluster:{uid:'same'},changes:[{after:'image@sha256:'+'b'.repeat(64)}]};
 const q=JSON.parse(JSON.stringify(p).replaceAll('/private/read-credential','/private/write-credential').replaceAll('/worker-one/source/chart','/worker-two/source/chart'));
 assert.equal(canonicalHash(semanticScopedPlan(p)),canonicalHash(semanticScopedPlan(q)));
 q.cluster.uid='different';assert.notEqual(canonicalHash(semanticScopedPlan(p)),canonicalHash(semanticScopedPlan(q)));
});
