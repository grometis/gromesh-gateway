import { readFile,writeFile,mkdir,lstat } from 'node:fs/promises';
import { createPublicKey,createPrivateKey } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runtimeConfig,privateCredential } from './protected.mjs';
import { verifyEnvelope,assertDeployableRelease } from './release.mjs';
import { canonicalHash } from './policy.mjs';
import { prepareReferenceEdits,referenceFiles } from './reference-patch.mjs';
import { DeliveryApp,deliveryPlan } from './delivery-app.mjs';
const exec=promisify(execFile);
async function main(){
 const config=await runtimeConfig('references.json','reference-coordinator');
 if(process.argv[2]==='policy'){await writeFile('reference-policy.json',JSON.stringify({prPublicationEnabled:config.prPublicationEnabled===true}));return;}
 if(!['prepare','publish-pr'].includes(process.argv[2]))throw Error('Unsupported operation');
 if(process.argv[2]==='publish-pr'&&config.prPublicationEnabled!==true)throw Error('PR publication not activated');
 const envelope=JSON.parse(await readFile('release-manifest.json','utf8')),producer=JSON.parse(await readFile('producer-context.json','utf8'));
 const release=assertDeployableRelease(verifyEnvelope(envelope,{publicKey:createPublicKey(config.releasePublicKey),keyId:config.releaseKeyId,purpose:'release'}));
 if(producer.result!=='SUCCESS'||producer.building!==false||canonicalHash(release.producer)!==canonicalHash(producer.build)||release.pipelineSha!==config.pipelineSha)throw Error('Exact completed official image-producing build required');
 const directory=process.cwd()+'/reference-source';
 await mkdir(directory,{mode:0o700});
 const env={PATH:'/opt/gromesh/tools/node/bin:/opt/gromesh/tools/bin:/usr/local/bin:/usr/bin:/bin',HOME:process.cwd()+'/git-home',LANG:'C.UTF-8',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'};
 await mkdir(env.HOME,{mode:0o700});
 const git=async args=>(await exec('git',args,{cwd:directory,env,timeout:120000,maxBuffer:2*1024*1024})).stdout;
 await git(['init','--template=']);await git(['remote','add','origin','https://github.com/grometis/gromesh-gateway.git']);
 await git(['fetch','--depth=1','--no-tags','origin',release.source.sha]);
 await git(['-c','core.hooksPath=/dev/null','checkout','--detach','FETCH_HEAD']);await git(['config','core.hooksPath','.githooks']);
 const files=new Map();
 for(const path of referenceFiles){const s=await lstat(directory+'/'+path);if(!s.isFile()||s.isSymbolicLink()||s.size>2*1024*1024)throw Error('Bounded regular reference source required');files.set(path,await readFile(directory+'/'+path,'utf8'));}
 const result=await prepareReferenceEdits(envelope,{publicKey:createPublicKey(config.releasePublicKey),keyId:config.releaseKeyId},files);
 await writeFile('reference-edits.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});
 if(process.argv[2]==='prepare')return;
 if(!result.edits.length)throw Error('No new reference changes; inspect existing PR before retry');
 const branch='task/J5-digests-'+release.source.sha;await git(['switch','-c',branch]);
 for(const edit of result.edits){if(canonicalHash(await readFile(directory+'/'+edit.path,'utf8'))!==edit.beforeHash)throw Error('Reference drift');await writeFile(directory+'/'+edit.path,edit.after);}
 await git(['add','--',...result.edits.map(e=>e.path)]);
 await git(['-c','user.name=gromesh-delivery[bot]','-c','user.email=gromesh-delivery[bot]@users.noreply.github.com','commit','-m','chore: pin verified Docker Hub release '+release.source.sha]);
 const sha=(await git(['rev-parse','HEAD'])).trim();
 const plan=deliveryPlan({branch,sha,base:'main',title:'chore: pin verified Docker Hub release '+release.source.sha,body:'Binds four public images to signed release '+result.releaseHash+'.\nAnonymous digest/tag readbacks passed.\nNo deployment, migration, merge or Actions cutover performed.\nRequires independent review and existing CI checks.'});
 const app=new DeliveryApp({appId:config.appId,installationId:config.installationId,privateKey:createPrivateKey(await privateCredential(process.env.GROMESH_DELIVERY_APP_PRIVATE_KEY_FILE))});
 await app.pushBranch(plan,directory);const pr=await app.createPr(plan);await writeFile('reference-pr.json',JSON.stringify(pr,null,2)+'\n');
}
main().catch(()=>{console.log(JSON.stringify({status:'REFERENCE_PR_NOT_CONFIGURED_OR_REFUSED'}));process.exitCode=78;});
