import { readFile,writeFile } from 'node:fs/promises';
import { createPrivateKey } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { assertPublishable } from './policy.mjs';
import { signEnvelope } from './release.mjs';
import { contextFromEnvironment } from './runner.mjs';
import { runtimeConfig,privateCredential } from './protected.mjs';
export function attestCi(report,expected,key,now){
 assertPublishable(expected.source,report,expected);
 if(!Number.isFinite(now))throw new Error('Trusted timestamp required');
 return signEnvelope({schema:'gromesh-ci-attestation/v1',report,issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+24*3600000).toISOString()},{...key,purpose:'ci'});
}
async function main(){
 const config=await runtimeConfig('ci-signing.json','ci-coordinator');
 const context=contextFromEnvironment(process.env,config.pipelineSha);
 const report=JSON.parse(await readFile('ci-result.json','utf8'));
 const privateKey=createPrivateKey(await privateCredential(process.env.GROMESH_CI_SIGNING_KEY_FILE));
 const envelope=attestCi(report,{source:context.source,pipelineSha:context.pipelineSha,job:context.build.job,buildId:context.build.id},{privateKey,keyId:config.keyId},Date.now());
 await writeFile('ci-attestation.json',JSON.stringify(envelope,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({status:'CI_ATTESTED',sourceSha:context.source.sha,buildId:context.build.id,keyId:config.keyId}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.log(JSON.stringify({status:'CI_SIGNING_NOT_CONFIGURED_OR_REFUSED'}));process.exitCode=78;});
