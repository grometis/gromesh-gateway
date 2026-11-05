import { mkdtemp,writeFile,lstat,unlink,rmdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { runtimeConfig,privateCredential } from './protected.mjs';
import { runCommand } from './ci.mjs';
export function validateImageProof(image,context,namespace,config){
 if(!/^(docker\.io\/fabriciobackend|ghcr\.io\/grometis)\/gromesh-ui@sha256:[a-f0-9]{64}$/.test(image??'')
  ||context!==config.kubeContext||namespace!==config.namespace)throw new Error('Image proof scope refused');
}
async function main(){
 const config=await runtimeConfig('image-proof.json','cd-image-proof');
 const [image,kubeconfig,context,namespace]=process.argv.slice(2);validateImageProof(image,context,namespace,config);
 if(typeof kubeconfig!=='string'||!kubeconfig.startsWith('/')||(kubeconfig!==process.env.GROMESH_DEV_PLAN_KUBECONFIG&&kubeconfig!==process.env.GROMESH_DEV_APPLY_KUBECONFIG))throw new Error('Dedicated DEV identity required');
 const directory=await mkdtemp('/workspace/image-proof-'),archive=join(directory,'previous.oci.tar'),auth=join(directory,'auth.json');
 try{
  let credentials=Buffer.from('{"auths":{}}');
  if(image.startsWith('ghcr.io/')&&config.ghcrReadCredentialConfigured===true)credentials=await privateCredential(process.env.GROMESH_GHCR_READ_AUTHFILE);
  await writeFile(auth,credentials,{mode:0o600,flag:'wx'});
  const env={PATH:'/opt/gromesh/tools/bin:/usr/local/bin:/usr/bin:/bin',HOME:directory,LANG:'C.UTF-8',DOCKER_CONFIG:directory,REGISTRY_AUTH_FILE:auth};
  const result=await runCommand(['skopeo','copy','--all','--preserve-digests','--src-authfile',auth,`docker://${image}`,`oci-archive:${archive}`],{env,timeoutMs:30*60000});
  if(result.status!=='SUCCESS'||result.exitCode!==0||(await lstat(archive)).size>config.maximumArchiveBytes)throw new Error('Previous image full pull failed or exceeded qualified budget');
  console.log(JSON.stringify({status:'PREVIOUS_IMAGE_AVAILABLE_FULL_PULL',image}));
 }finally{
  for(const path of [archive,auth])try{await unlink(path);}catch(e){if(e.code!=='ENOENT')throw e;}
  await rmdir(directory);
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.log(JSON.stringify({status:'IMAGE_PROOF_NOT_CONFIGURED_OR_REFUSED'}));process.exitCode=78;});
