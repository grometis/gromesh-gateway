import { isSha,isDigest } from './policy.mjs';
import { hubReference,pushArguments } from './registry.mjs';
const refuse=reason=>{throw new Error(`Image pipeline refused: ${reason}`);};
export function nativeBuildPlan({component,sha,architecture,workerArchitecture,directory='/workspace'}){
 hubReference(component,sha);
 if(!['amd64','arm64'].includes(architecture)||workerArchitecture!==architecture)refuse('qualified native architecture required');
 if(!/^\/workspace(?:\/(?:builds|candidates)\/[1-9][0-9]*)?$/.test(directory))refuse('private image workspace');
 const root=`${directory}/${component}-${architecture}`,archive=root+'.oci.tar';
 // BuildKit fetches immutable public Git content; candidate processes cannot substitute local files/index flags.
 const context=`https://github.com/grometis/gromesh-gateway.git#${sha}${component==='kong'?':images/kong':''}`;
 const dockerfile=component==='kong'?'Dockerfile':`apps/${component}/Dockerfile`;
 return [
  {phase:'build',file:'docker',args:['buildx','--builder','gromesh-native','build','--platform',`linux/${architecture}`,'--tag',`gromesh-ci/${component}:sha-${sha}-${architecture}`,'--provenance=mode=max','--sbom=true','--label',`org.opencontainers.image.revision=${sha}`,'--label','org.opencontainers.image.source=https://github.com/grometis/gromesh-gateway','--output',`type=oci,dest=${archive}`,'--file',dockerfile,context]},
  {phase:'sbom',file:'syft',args:[`oci-archive:${archive}`,'--output',`spdx-json=${root}.spdx.json`]},
  {phase:'scan',file:'trivy',args:['image','--input',archive,'--platform',`linux/${architecture}`,'--scanners','vuln','--severity','CRITICAL','--exit-code','1','--ignorefile','/dev/null','--format','json','--output',`${root}.trivy.json`,'--timeout','15m']}
 ];
}
export function publicationPlan(input){
 const reference=hubReference(input.component,input.sha,input.publication);
 if(!isDigest(input.digest)||!(input.existingDigest===null||isDigest(input.existingDigest)))refuse('verified registry lookup required');
 if(input.existingDigest!==null&&input.existingDigest!==input.digest)refuse('SHA tag already exists with different bytes');
 const verify={phase:'verify-anonymous-pull',file:'skopeo',args:['inspect','--raw',`docker://${reference.split(':')[0]}@${input.digest}`],expectedDigest:input.digest};
 return input.existingDigest===input.digest?[verify]:[{phase:'publish',file:'skopeo',args:pushArguments(input)},verify];
}
