import { readFile,writeFile } from 'node:fs/promises';
import { createPublicKey } from 'node:crypto';
import { assertDevKubeconfig } from './dev-identity.mjs';
import { devReview,checkDevAccess } from './dev-reviews.mjs';
import { createDevAdapters } from './dev-adapters.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { runtimeConfig,privateCredential } from './protected.mjs';
import { inventoryMigrations } from './migrations.mjs';
import { verifyEnvelope } from './release.mjs';
import { createPlan,runGuardPlan,createRollbackPlan,applyPlan } from './cd.mjs';
import { J5_POLICY } from './approval.mjs';
const exec=promisify(execFile),refuse=reason=>{throw new Error(`DEV pipeline refused: ${reason}`);};
export async function liveLedger(sourceInventory,query,expectedDatabase){
 try{
  const data=await query();
  if(data.database!==expectedDatabase||!Array.isArray(data.sql)||!Array.isArray(data.data))return null;
  const files=[];
  for(const [i,row]of data.sql.entries()){
   const source=sourceInventory.files[i];if(!source||row.hash!==source.sha256||String(row.createdAt)!==String(source.journalTime))return null;
   files.push({name:source.name,sha256:row.hash});
  }
  if(!data.data.includes('n1-workspaces'))return null;
  return {source:'authenticated-plan-identity',verified:true,files};
 }catch{return null;}
}
export async function prepareRuntimePlan(config,{envelope,credentialRole='plan',operation='plan',context}){
 if(config.target?.environment!=='DEV'||config.guardSha256!=='fc43f4f3aa10d709b2abac79baa791b15bb14846a9436e33ef0f88f2fd25f314')refuse('trusted DEV policy');
 const key={publicKey:createPublicKey(config.releasePublicKey),keyId:config.releaseKeyId};
 const release=verifyEnvelope(envelope,{...key,purpose:'release'});
 // Reading a dedicated secret-file credential never copies or imports an administrative kubeconfig.
 const kubeconfig=process.env[credentialRole==='apply'?'GROMESH_DEV_APPLY_KUBECONFIG':'GROMESH_DEV_PLAN_KUBECONFIG'];
 await privateCredential(kubeconfig);
 const options={...config.guardOptions,kubeconfig};
 const env={PATH:'/opt/gromesh/tools/node/bin:/opt/gromesh/tools/bin:/usr/local/bin:/usr/bin:/bin',HOME:process.env.HOME,LANG:'C.UTF-8',KUBECONFIG:options.kubeconfig};
 const kube=async args=>JSON.parse((await exec('kubectl',['--kubeconfig',options.kubeconfig,'--context',options.kubeContext,...args],{env,timeout:20000,maxBuffer:2*1024*1024})).stdout);
 const connection=await kube(['config','view','--minify','--raw','-o','json']);
 const expectedUsername=assertDevKubeconfig(connection,config.target,credentialRole,Date.now());
 const identity=await devReview(connection,config.target,'identity');
 if(identity.status?.userInfo?.username!==expectedUsername)refuse('authenticated DEV identity');
 await checkDevAccess(connection,config.target,credentialRole);
 const sha=(await exec('git',['--no-replace-objects','rev-parse','HEAD'],{env,timeout:10000})).stdout.trim();
 if(sha!==release.source?.sha)refuse('source SHA');
 const source=await inventoryMigrations('apps/control-plane/drizzle',null);
 let ledger=null;
 if(config.database?.readIdentityConfigured===true){
  await privateCredential(process.env.GROMESH_DEV_PLAN_PGSERVICEFILE);
  const dbEnv={...env,PGSERVICEFILE:process.env.GROMESH_DEV_PLAN_PGSERVICEFILE,PGSERVICE:'gromesh-dev-plan',PGOPTIONS:'-c default_transaction_read_only=on -c statement_timeout=5000'};
  const sql=`select json_build_object('database',current_database(),'sql',(select coalesce(json_agg(json_build_object('hash',hash,'createdAt',created_at) order by created_at),'[]'::json) from drizzle.__drizzle_migrations),'data',(select coalesce(json_agg(name),'[]'::json) from public.data_migrations))`;
  ledger=await liveLedger(source,async()=>JSON.parse((await exec('psql',['--no-psqlrc','--no-align','--tuples-only','--set','ON_ERROR_STOP=1','--command',sql],{env:dbEnv,timeout:10000,maxBuffer:1024*1024})).stdout),config.database.name);
 }
 const migrations=await inventoryMigrations('apps/control-plane/drizzle',ledger);
 const image=release.artifacts?.find(a=>a.component==='ui');if(!image)refuse('release UI');
 options.image='docker.io/fabriciobackend/gromesh-ui@'+image.indexDigest;
 const before=await kube(['get','Deployment',options.release+'-control-plane','-n',options.namespace,'-o','json']);
 const scopedPlan=await runGuardPlan(options,{guardPath:'/opt/gromesh/guard/helm-scoped-rollout.mjs',expectedSha256:config.guardSha256});
 const after=await kube(['get','Deployment',options.release+'-control-plane','-n',options.namespace,'-o','json']);
 const cpImage=before.spec?.template?.spec?.containers?.find(c=>c.name==='control-plane')?.image;
 if(before.metadata?.uid!==after.metadata?.uid||before.metadata?.resourceVersion!==after.metadata?.resourceVersion)refuse('CP changed during plan');
 const pulled=JSON.parse((await exec('/opt/gromesh/tools/node/bin/node',['/opt/gromesh/jenkins/image-proof.mjs',options.image,kubeconfig,options.kubeContext,options.namespace],{env:{...env,GROMESH_DEV_PLAN_KUBECONFIG:process.env.GROMESH_DEV_PLAN_KUBECONFIG,GROMESH_DEV_APPLY_KUBECONFIG:process.env.GROMESH_DEV_APPLY_KUBECONFIG},timeout:31*60000,maxBuffer:65536})).stdout);
 if(pulled.status!=='PREVIOUS_IMAGE_AVAILABLE_FULL_PULL'||pulled.image!==options.image)refuse('target full pull proof');
 const targetImageProof={reference:options.image,available:true,method:'ANONYMOUS_FULL_PULL',observedAt:new Date().toISOString()};
 const plan=createPlan({component:'ui',operation:operation==='rollback-plan'?'ROLLBACK_PLAN':'DEPLOY_PLAN',rollbackProof:config.rollbackProof,targetImageProof,releaseEnvelope:envelope,releaseKey:key,target:config.target,scopedPlan,migrations,compatibility:config.compatibility,backup:config.backup,unchangedCpImage:cpImage,rollbackImageAvailable:config.rollbackImageAvailable,
  context:{...context,now:Date.now()}});
 return {plan,options};
}
async function main(){
 const command=process.argv[2];
 if(command==='apply'&&(!J5_POLICY.applyEnabled||!J5_POLICY.firstDevApplyAuthorized)){await applyPlan();return;}
 if(!['policy','plan','rollback-plan','apply'].includes(command))refuse('operation');
 const config=await runtimeConfig(command==='apply'?'cd-apply.json':'cd-plan.json',command==='apply'?'cd-apply':'cd-plan');
 if(command==='policy'){await writeFile('plan-policy.json',JSON.stringify({databaseReadIdentityConfigured:config.database?.readIdentityConfigured===true,ghcrReadCredentialConfigured:config.ghcrReadCredentialConfigured===true},null,2)+'\n',{mode:0o600});return;}
 const envelope=JSON.parse(await readFile('release-manifest.json','utf8'));
 const context={requester:process.env.GROMESH_REQUESTER,job:process.env.JOB_NAME,buildId:process.env.BUILD_NUMBER};
 if(command==='apply'){
  if(config.applyEnabled!==true)refuse('write policy');
  const plan=JSON.parse(await readFile('dev-plan.json','utf8')),receipt=JSON.parse(await readFile('dev-approval.json','utf8'));
  if(plan.job!==context.job||plan.buildId!==context.buildId||plan.requester!==context.requester)refuse('current authenticated build');
  const adapters=createDevAdapters(plan,config,()=>prepareRuntimePlan(config,{envelope,credentialRole:'apply',operation:plan.operation==='ROLLBACK_PLAN'?'rollback-plan':'plan',context}));
  const result=await applyPlan(plan,receipt,{allowedApprovers:config.allowedApprovers,verificationKey:{publicKey:createPublicKey(config.approvalPublicKey),keyId:config.approvalKeyId}},adapters);
  await writeFile('dev-apply-result.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});return;
 }
 if(config.applyEnabled!==false)refuse('read-only PLAN policy');
 const {plan}=await prepareRuntimePlan(config,{envelope,operation:command,context});
 await writeFile('dev-plan.json',JSON.stringify(plan,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({status:'DEV_PLAN_PREPARED_APPLY_DISABLED',planHash:plan.planHash,blockers:plan.blockers,applyEnabled:J5_POLICY.applyEnabled}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.log(JSON.stringify({status:'DEV_NOT_CONFIGURED_OR_REFUSED',applyEnabled:false}));process.exitCode=78;});
