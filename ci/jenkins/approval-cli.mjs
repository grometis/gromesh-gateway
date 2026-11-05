import { readFile,writeFile } from 'node:fs/promises';
import { createPrivateKey,createPublicKey } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runtimeConfig,privateCredential } from './protected.mjs';
import { J5_POLICY,createReceipt } from './approval.mjs';
async function main(){
 const config=await runtimeConfig('cd-approval.json','cd-approval');
 if(process.argv[2]==='policy'){
  await writeFile('approval-policy.json',JSON.stringify({applyEnabled:J5_POLICY.applyEnabled&&J5_POLICY.firstDevApplyAuthorized,allowedApprovers:config.allowedApprovers,databaseReadIdentityConfigured:config.databaseReadIdentityConfigured===true,ghcrReadCredentialConfigured:config.ghcrReadCredentialConfigured===true},null,2)+'\n',{mode:0o600});return;
 }
 if(process.argv[2]!=='approve'||!J5_POLICY.applyEnabled||!J5_POLICY.firstDevApplyAuthorized)throw new Error('No operational approval authorized in J5');
 const plan=JSON.parse(await readFile('dev-plan.json','utf8')),authenticated=JSON.parse(await readFile('approval-context.json','utf8'));
 if(plan.job!==process.env.JOB_NAME||plan.buildId!==process.env.BUILD_NUMBER||plan.requester!==process.env.GROMESH_REQUESTER)throw new Error('Current authenticated build required');
 const privateKey=createPrivateKey(await privateCredential(process.env.GROMESH_DEV_APPROVAL_SIGNING_KEY_FILE));
 if(privateKey.asymmetricKeyType!=='ed25519'||createPublicKey(privateKey).export({type:'spki',format:'pem'})!==createPublicKey(config.approvalPublicKey).export({type:'spki',format:'pem'}))throw new Error('Dedicated approval signing identity required');
 const receipt=createReceipt(plan,authenticated,{allowedApprovers:config.allowedApprovers,signingKey:{privateKey,keyId:config.approvalKeyId}},Date.now());
 await writeFile('dev-approval.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({status:'EXACT_PLAN_APPROVED',planHash:receipt.payload.planHash,submitters:receipt.payload.submitters}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.log(JSON.stringify({status:'APPROVAL_NOT_CONFIGURED_OR_REFUSED',applyEnabled:false}));process.exitCode=78;});
