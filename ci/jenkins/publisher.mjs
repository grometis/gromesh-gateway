import { readFile,writeFile,mkdir,lstat } from 'node:fs/promises';
import { createPublicKey,createPrivateKey } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runtimeConfig,privateCredential } from './protected.mjs';
import { inspectBundle } from './bundle.mjs';
import { publicationPlan } from './images.mjs';
import { hubReference } from './registry.mjs';
import { resolveHubDigest } from './hub.mjs';
import { signEnvelope } from './release.mjs';
import { runCommand } from './ci.mjs';
import { imageWorkspace } from './workspaces.mjs';
const refuse=reason=>{throw new Error(`Publisher refused: ${reason}`);};
export async function publishVerifiedBundle(request,trusted,{directory='/workspace',execute=runCommand,lookup=resolveHubDigest,env,authfile}={}){
 const {release}=await inspectBundle(request,directory,trusted);
 if(directory!==`/workspace/builds/${trusted.imageBuild.id}`||!authfile?.startsWith(directory+'@tmp/secretFiles/'))refuse('private per-build publisher paths');
 const receipts=[];
 for(const a of release.artifacts){
  const existingDigest=await lookup(a.component,'sha-'+release.source.sha);
  const commands=publicationPlan({component:a.component,sha:release.source.sha,archive:`${directory}/${a.component}.oci.tar`,authfile,digest:a.indexDigest,existingDigest});
  for(const command of commands.filter(c=>c.phase==='publish')){
   const r=await execute([command.file,...command.args],{env,timeoutMs:60*60000});if(r.status!=='SUCCESS'||r.exitCode!==0)refuse('push failed');
  }
  if(await lookup(a.component,'sha-'+release.source.sha)!==a.indexDigest||await lookup(a.component,a.indexDigest)!==a.indexDigest)refuse('published digest readback');
  // Explicit anonymous full pull of every architecture/layer, outside the writer authfile.
  const pull=await execute(['skopeo','copy','--all','--preserve-digests','--authfile',directory+'/anonymous-auth.json',`docker://${hubReference(a.component,release.source.sha).split(':')[0]}@${a.indexDigest}`,`oci:${directory}/anonymous-pull/${a.component}`],{env:{...env,DOCKER_CONFIG:directory+'/anonymous-docker'},timeoutMs:60*60000});
  if(pull.status!=='SUCCESS'||pull.exitCode!==0)refuse('anonymous complete pull');
  receipts.push({component:a.component,indexDigest:a.indexDigest,shaTagVerified:true,anonymousPull:'SUCCESS',publishedAt:new Date().toISOString()});
 }
 return {...release,publication:receipts};
}
async function main(){
 const config=await runtimeConfig('publisher.json','image-publisher');
 const directory=await imageWorkspace(process.env.BUILD_NUMBER);
 if(config.publicationEnabled!==true||config.artifactTransport?.qualified!==true)refuse('publication activation/capacity');
 const request=JSON.parse(await readFile(directory+'/release-request.json','utf8')),context=JSON.parse(await readFile(directory+'/ci-context.json','utf8'));
 const trusted={...context,now:Date.now(),nativeWorkers:config.nativeWorkers,registry:config.registry,ciKey:{publicKey:createPublicKey(config.ciPublicKey),keyId:config.ciKeyId},artifactKey:{publicKey:createPublicKey(config.artifactPublicKey),keyId:config.artifactKeyId}};
 await inspectBundle(request,directory,trusted);
 if(process.argv[2]!=='publish')refuse('operation');
 const auth=JSON.parse(await privateCredential(process.env.GROMESH_HUB_AUTH_FILE));
 if(Object.keys(auth.auths??{}).length!==1||!auth.auths['docker.io']?.auth)refuse('dedicated Hub authfile');
 const principal=Buffer.from(auth.auths['docker.io'].auth,'base64').toString('utf8');
 if(principal.slice(0,principal.indexOf(':'))!==config.registry.writerUsername||!principal.includes(':')||!principal.split(':').slice(1).join(':'))refuse('authorized writer identity');
 const privateKey=createPrivateKey(await privateCredential(process.env.GROMESH_RELEASE_SIGNING_KEY_FILE));
 if(!/^[a-z0-9-]{1,80}$/.test(config.releaseKeyId??'')||createPublicKey(privateKey).export({type:'spki',format:'pem'})!==createPublicKey(config.releasePublicKey).export({type:'spki',format:'pem'}))refuse('release signing identity');
 await mkdir(directory+'/anonymous-docker',{recursive:true,mode:0o700});
 const anonymous=directory+'/anonymous-auth.json';
 try{await writeFile(anonymous,'{"auths":{}}',{mode:0o600,flag:'wx'});}catch(e){const s=await lstat(anonymous);if(e.code!=='EEXIST'||!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)!==0||await readFile(anonymous,'utf8')!=='{"auths":{}}')throw e;}
 const env={PATH:'/opt/gromesh/tools/node/bin:/opt/gromesh/tools/bin:/usr/local/bin:/usr/bin:/bin',HOME:process.env.HOME,LANG:'C.UTF-8',DOCKER_CONFIG:directory+'/anonymous-docker'};
 const release=await publishVerifiedBundle(request,trusted,{directory,execute:runCommand,env,authfile:process.env.GROMESH_HUB_AUTH_FILE});
 await writeFile(directory+'/release-manifest.json',JSON.stringify(signEnvelope(release,{privateKey,keyId:config.releaseKeyId,purpose:'release'}),null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({status:'RELEASE_PUBLISHED_AND_SIGNED',sha:release.source.sha,components:release.artifacts.map(a=>a.component)}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.log(JSON.stringify({status:'PUBLISHER_NOT_CONFIGURED_OR_REFUSED'}));process.exitCode=78;});
