import { NonceStore } from './nonce-store.mjs';
import { runGuardApply } from './cd.mjs';
export function createDevAdapters(plan,config,prepare){
 if(config.nonceStore?.path!=='/var/lib/gromesh-jenkins/dev-nonces'||config.nonceStore.durableVerified!==true||config.helmStorageAdmissionVerified!==true)throw new Error('Durable replay protection and scoped Helm storage admission must be qualified');
 const store=new NonceStore(config.nonceStore.path);
 const options={...config.guardOptions,kubeconfig:process.env.GROMESH_DEV_APPLY_KUBECONFIG,image:plan.changes[0].after};
 return {now:()=>Date.now(),readConsumedNonces:()=>store.read(),reserveNonce:(nonce,hash)=>store.reserve(nonce,hash),
  revalidate:async()=>{const current=await prepare();return current.plan;},protectedOptions:options,
  scopedGuard:verifiedOptions=>runGuardApply(verifiedOptions,{guardPath:'/opt/gromesh/guard/helm-scoped-rollout.mjs',expectedSha256:config.guardSha256})};
}
