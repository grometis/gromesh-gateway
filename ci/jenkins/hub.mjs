import { hubReference,byteDigest } from './registry.mjs';
import { isDigest } from './policy.mjs';
const refuse=reason=>{throw new Error(`Hub lookup refused: ${reason}`);};
export async function resolveHubDigest(component,reference,{transport=fetch}={}){
 hubReference(component,'a'.repeat(40));
 if(!/^(?:sha-[a-f0-9]{40}|ci-[a-f0-9]{40}-[1-9][0-9]*)$/.test(reference)&&!isDigest(reference))refuse('immutable reference');
 const repository=`fabriciobackend/gromesh-${component}`;
 const auth=await transport('https://auth.docker.io/token?service=registry.docker.io&scope='+encodeURIComponent('repository:'+repository+':pull'),{redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!auth.ok)refuse('anonymous pull authorization');
 const token=(await auth.json()).token;if(typeof token!=='string'||token.length>16384||!token)refuse('anonymous authorization response');
 const response=await transport(`https://registry-1.docker.io/v2/${repository}/manifests/${reference}`,{headers:{Authorization:'Bearer '+token,Accept:'application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json'},redirect:'error',signal:AbortSignal.timeout(20000)});
 if(response.status===404)return null;if(!response.ok)refuse('registry HTTP '+response.status);
 let count=0;const chunks=[];for await(const chunk of response.body){count+=chunk.length;if(count>1024*1024)refuse('manifest budget');chunks.push(Buffer.from(chunk));}
 const digest=byteDigest(Buffer.concat(chunks));if(response.headers.get('docker-content-digest')&&response.headers.get('docker-content-digest')!==digest)refuse('manifest digest header mismatch');
 if(isDigest(reference)&&digest!==reference)refuse('requested digest mismatch');return digest;
}
