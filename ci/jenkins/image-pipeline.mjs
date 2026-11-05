import {assertImageToolchain} from './image-toolchain.mjs';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { nativeBuildPlan } from './images.mjs';
import { byteDigest } from './registry.mjs';
import { readOciArchive } from './oci-archive.mjs';
import { inspectWorker } from './worker.mjs';
import { runCommand } from './ci.mjs';
import { isSha } from './policy.mjs';
import { imageWorkspace } from './workspaces.mjs';
import { configureNativeBuilder } from './buildx.mjs';
import { contextFromEnvironment } from './runner.mjs';
import { kongCandidateRequired } from './kong-candidate.mjs';
const exec=promisify(execFile),refuse=reason=>{throw new Error(`Image build refused: ${reason}`);};
export async function executeNativeBuild({component,sha,pipelineSha,architecture,worker,checkedOutSha,clean,execute,env,directory='/workspace',purpose='official',readArchive=readOciArchive}){
 if(!isSha(sha)||checkedOutSha!==sha||!isSha(pipelineSha)||worker.policy.pipelineSha!==pipelineSha)refuse('source/pipeline SHA');
 const roleAllowed=purpose==='official'?worker.policy.role==='image-builder':purpose==='candidate'&&component==='kong'&&worker.policy.role==='ci';
 if(clean!==true||!roleAllowed||worker.facts.architecture!==architecture||worker.policy.buildkit?.rootless!==true
  ||worker.policy.buildkit.driver!=='remote'||worker.policy.buildkit.endpoint!==`unix:///run/user/${worker.facts.uid}/buildkit/buildkitd.sock`)refuse('isolated native BuildKit qualification');
 const steps=nativeBuildPlan({component,sha,architecture,workerArchitecture:worker.facts.architecture,directory});
 const reports=[];
 for(const step of steps){const result=await execute([step.file,...step.args],{env,output:`${directory}/evidence/${component}-${architecture}/${step.phase}`,timeoutMs:step.phase==='build'?6*3600000:30*60000});reports.push({phase:step.phase,...result});if(result.status!=='SUCCESS'||result.exitCode!==0)refuse(`failed ${step.phase}`);}
 const root=`${directory}/${component}-${architecture}`;
 const archive=await readArchive(root+'.oci.tar',{sha,platforms:[`linux/${architecture}`]});
 const sbomBytes=await readFile(root+'.spdx.json'),sbom=JSON.parse(sbomBytes);
 const scanBytes=await readFile(root+'.trivy.json'),scan=JSON.parse(scanBytes);
 if(!/^SPDX-2\.[23]$/.test(sbom.spdxVersion??'')||!Array.isArray(sbom.packages)||!sbom.documentNamespace||scan.SchemaVersion!==2||!scan.Metadata||!Array.isArray(scan.Results))refuse('structured SBOM/scan reports');
 if(scan.Results.some(r=>r.Vulnerabilities?.some(v=>v.Severity==='CRITICAL')))refuse('critical vulnerability');
 let kongTestsPassed=false;
 if(component==='kong'){
  const image=`gromesh-ci-kong:sha-${sha}`;
  const check=async(phase,argv)=>{const output=`${directory}/evidence/kong-${architecture}/${phase}`;const result=await execute(argv,{env:{...env,KONG_IMAGE:image},output,timeoutMs:phase==='smoke'?90*60000:20*60000});reports.push({phase,...result});if(result.status!=='SUCCESS'||result.exitCode!==0)refuse(`Kong ${phase}`);return readFile(output+'/stdout.log','utf8');};
  await check('load',['skopeo','--override-os','linux','--override-arch',architecture,'copy',`oci-archive:${root}.oci.tar`,`docker-daemon:${image}`]);
  const config=(await check('config',['docker','image','inspect',image,'--format','{{.Id}}'])).trim();
  if(config!==archive.proof.images[0]?.configDigest)refuse('Kong imported bytes differ');
  const limit=['docker','run','--rm','--label','gromesh.j5.run='+env.GROMESH_CI_RUN,'--network','none','--cpus','1','--memory','512m','--pids-limit','128',image];
  if((await check('version',[...limit,'kong','version'])).trim()!=='3.9.4')refuse('Kong version');
  const uid=(await check('nonroot',[...limit,'id','-u'])).trim();if(!/^[1-9][0-9]*$/.test(uid))refuse('Kong nonroot');
  await check('smoke',['/bin/bash','/opt/gromesh/jenkins/stages/kong-acceptance.sh']);kongTestsPassed=true;
 }
 const after=await readArchive(root+'.oci.tar',{sha,platforms:[`linux/${architecture}`]});
 if(after.archiveHash!==archive.archiveHash)refuse('exported bytes changed after scan/acceptance');
 return {schema:'gromesh-native-image/v1',component,sourceSha:sha,pipelineSha,platform:`linux/${architecture}`,indexDigest:archive.proof.digest,archiveHash:archive.archiveHash,
  sbomHash:byteDigest(sbomBytes),scanHash:byteDigest(scanBytes),scanStatus:'PASS',critical:0,reports,kongTestsPassed,toolchainVerified:true};
}
async function main(){
 let worker;try{worker=await inspectWorker();}catch{console.log(JSON.stringify({status:'WORKER_NOT_QUALIFIED'}));process.exitCode=78;return;}
 const candidate=process.argv[2]==='candidate';
 if(candidate){
  if(!/^gromesh-gateway\/gromesh-ci\/gromesh-(main|prs|branches)$/.test(process.env.JOB_NAME??'')||worker.policy.role!=='ci')refuse('credential-free candidate CI job');
  let required=false;
  if(process.env.GROMESH_SOURCE_EVENT==='pull_request'){
   const context=contextFromEnvironment({...process.env,GROMESH_BASE_SHA:process.env.GROMESH_PR_BASE_SHA},worker.policy.pipelineSha);
   const files=(await exec('git',['--no-replace-objects','diff','--no-ext-diff','--name-only','-z',context.source.baseSha,context.source.sha],{timeout:10000,maxBuffer:1024*1024})).stdout.split('\0').filter(Boolean);
   required=kongCandidateRequired(context.source.event,files);
  }
  if(!required){
   if(process.env.GROMESH_CI_EVIDENCE){await writeFile(process.env.GROMESH_CI_EVIDENCE+'/kong-candidate.json',JSON.stringify({schema:'gromesh-kong-candidate/v1',required:false,passed:null,sourceSha:process.env.GROMESH_SOURCE_SHA})+'\n',{mode:0o600});await writeFile(process.env.GROMESH_CI_EVIDENCE+'/kong-candidate.log','No matching PR Kong paths.\n',{mode:0o600});}
   console.log(JSON.stringify({status:'KONG_CANDIDATE_NOT_APPLICABLE'}));return;
  }
 }else if(process.argv[2]!=='build'||process.env.JOB_NAME!=='gromesh-artifacts/gromesh-images'||process.env.BUILD_URL!==`https://jenkins.grometis.com/job/gromesh-artifacts/job/gromesh-images/${process.env.BUILD_NUMBER}/`)refuse('approved image job');
 const sha=process.env.GROMESH_SOURCE_SHA,pipelineSha=process.env.GROMESH_PIPELINE_SHA,architecture=worker.facts.architecture;
 if(pipelineSha!==worker.policy.pipelineSha)refuse('immutable runtime revision');
 if(process.argv[3]==='kong'&&worker.policy.kongBuildCapacityQualified!==true)refuse('Kong build capacity must be separately measured/qualified');
 const directory=await imageWorkspace(process.env.BUILD_NUMBER,candidate?{base:'/workspace/candidates'}:{});
 const abort=new AbortController();for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>abort.abort());
 let tools={PATH:'/opt/gromesh/tools/node/bin:/opt/gromesh/tools/bin:/usr/local/bin:/usr/bin:/bin',HOME:process.env.HOME,USER:process.env.USER,LANG:'C.UTF-8',CI:'1',JENKINS_URL:'https://jenkins.grometis.com/',
  DOCKER_HOST:worker.facts.docker.endpoint,DOCKER_CONFIG:directory+'/.docker-no-credentials',GIT_TERMINAL_PROMPT:'0',GROMESH_CI_RUN:candidate?process.env.GROMESH_CI_RUN:randomBytes(16).toString('hex'),npm_config_userconfig:'/opt/gromesh/jenkins/npmrc',npm_config_globalconfig:'/opt/gromesh/jenkins/npmrc'};
 tools.GROMESH_CI_STATE='/tmp/gromesh-jenkins-'+tools.GROMESH_CI_RUN;
 await mkdir(tools.DOCKER_CONFIG,{recursive:true,mode:0o700});
 const versions={};
 for(const [name,file,args] of [['syft','syft',['version']],['trivy','trivy',['--version']],['buildx','docker',['buildx','version']]]){
  versions[name]=(await exec(file,args,{env:tools,timeout:10000,maxBuffer:65536})).stdout;
 }
 assertImageToolchain(versions);
 tools=await configureNativeBuilder(worker.policy.buildkit,architecture,directory,tools,async(argv,options)=>exec(argv[0],argv.slice(1),{...options,signal:abort.signal}));
 const checkedOutSha=(await exec('git',['rev-parse','HEAD'],{env:tools,timeout:10000})).stdout.trim();
 const clean=(await exec('git',['status','--porcelain','--untracked-files=all'],{env:tools,timeout:10000})).stdout.trim()==='';
 let result;
 try{result=await executeNativeBuild({component:process.argv[3],sha,pipelineSha,architecture,worker,checkedOutSha,clean,env:tools,directory,purpose:candidate?'candidate':'official',execute:(argv,options)=>runCommand(argv,{...options,signal:abort.signal})});}
 finally{
  if(candidate&&process.env.GROMESH_CI_EVIDENCE){
   let logs='';for(const phase of ['build','sbom','scan','load','config','version','nonroot','smoke'])for(const stream of ['stdout','stderr']){try{const b=await readFile(`${directory}/evidence/kong-${architecture}/${phase}/${stream}.log`,'utf8');logs+=`\n[${phase}/${stream}]\n`+b.slice(0,65536);}catch{}}
   await writeFile(process.env.GROMESH_CI_EVIDENCE+'/kong-candidate.log',logs,{mode:0o600});
   await writeFile(process.env.GROMESH_CI_EVIDENCE+'/kong-candidate.json',JSON.stringify({schema:'gromesh-kong-candidate/v1',required:true,passed:result?.kongTestsPassed===true,sourceSha:sha,platform:'linux/'+architecture,indexDigest:result?.indexDigest??null})+'\n',{mode:0o600});
  }
  if(process.argv[3]==='kong'){const cleanup=await runCommand(['/bin/bash','/opt/gromesh/jenkins/stages/cleanup.sh'],{env:tools,timeoutMs:60000});if(cleanup.status!=='SUCCESS')refuse('candidate resource cleanup failed');}
 }
 result.build={job:process.env.JOB_NAME,id:process.env.BUILD_NUMBER,url:process.env.BUILD_URL,pipelineSha};result.workerId=worker.facts.id;
 await writeFile(`${directory}/${result.component}-${architecture}.result.json`,JSON.stringify(result,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({status:'NATIVE_IMAGE_BUILT_NOT_PUBLISHED',component:result.component,platform:result.platform,indexDigest:result.indexDigest,kongTestsPassed:result.kongTestsPassed}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.log(JSON.stringify({status:'IMAGE_PIPELINE_REFUSED'}));process.exitCode=1;});
