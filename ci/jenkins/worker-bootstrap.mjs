import {readFile,writeFile,lstat,readdir,realpath,mkdir,rename,unlink,chmod} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {hostname,arch,platform,totalmem,availableParallelism,tmpdir} from 'node:os';
import {join,resolve,dirname,relative,isAbsolute} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const exec=promisify(execFile),hash=b=>createHash('sha256').update(b).digest('hex');
const refuse=s=>{throw new Error('Bootstrap refused: '+s);};
const sha=s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s);
const roles={ci:{file:'worker.json',floor:[8,16384,100],domains:[]},'image-builder':{file:'worker.json',floor:[8,16384,100],domains:[]},'github-coordinator':{file:'github-app.json',floor:[1,512,5],domains:['github-app','ci-attestation']},'image-coordinator':{file:'images.json',floor:[2,4096,300],domains:['artifact-signing']},'image-publisher':{file:'publisher.json',floor:[2,2048,400],domains:['dockerhub-write','release-signing']},'reference-coordinator':{file:'references.json',floor:[1,1024,10],domains:['github-delivery-app']}};
export function validateBootstrapAuthorization(a,f,now=Date.now()){
 if(!a||!f||a.schema!=='gromesh-host-authorization/v1'||a.approved!==true||!roles[a.role]||!sha(a.pipelineSha)
  ||!Number.isFinite(now)||!Number.isSafeInteger(a.executorUid)||a.executorUid<1000||a.executorUid!==f.executorUid
  ||!/^[a-z0-9-]{3,100}$/.test(a.id??'')||!/^[a-z0-9][a-z0-9.-]{1,100}$/.test(a.hostname??'')
  ||!/^[a-f0-9]{64}$/.test(a.machineIdHash??'')||!['amd64','arm64'].includes(a.architecture))refuse('authorization identity');
 if(f.os!=='linux'||f.uid!==0||/apple/i.test(f.hardwareVendor??'')||/gromesh-n2|macbook|macmini|mac-mini|docker-desktop/i.test(a.id+' '+a.hostname)
  ||f.hostname!==a.hostname||f.machineIdHash!==a.machineIdHash||f.architecture!==a.architecture)refuse('authorized Linux host only');
 if(a.file?.uid!==0||a.file.symlink!==false||!Number.isInteger(a.file.mode)||(a.file.mode&0o077)!==0)refuse('root-owned private authorization');
 const start=Date.parse(a.issuedAt),end=Date.parse(a.expiresAt);
 if(!Number.isFinite(start)||!Number.isFinite(end)||start>now+30000||end<=now||end<=start||end-start>86400000)refuse('authorization expiry');
 return {authorized:true,workerQualified:false};
}
export function assessReadiness(p,f){
 const role=roles[p?.role];if(!role)refuse('role');
 const floor=role.floor,container=['ci','image-builder'].includes(p.role);
 const checks={linux:f.os==='linux',kernel:/^(?:[6-9]|[1-9][0-9])\./.test(f.kernel??'')||/^5\.(?:1[5-9]|[2-9][0-9])\./.test(f.kernel??''),
  cpu:Number.isFinite(f.cpus)&&f.cpus>=Math.max(floor[0],p.minimumCpus??floor[0]),memory:Number.isFinite(f.memoryMiB)&&f.memoryMiB>=Math.max(floor[1],p.minimumMemoryMiB??floor[1]),disk:Number.isFinite(f.diskFreeGiB)&&f.diskFreeGiB>=Math.max(floor[2],p.minimumDiskGiB??floor[2]),
  java:f.javaMajor===21,node:f.node==='v26.13.0',cgroups:f.cgroupVersion===2&&['cpu','memory','pids'].every(x=>f.cgroupControllers?.includes(x)),systemd:f.systemdDriver===true&&f.delegated===true,
  protectedEvidence:f.proofAuthorityVerified===true,reset:f.resetVerified===true,network:f.n2Denied===true&&f.dns===true&&f.ntp===true&&f.egressTls===true,quota:f.diskQuotaEnforced===true,
  ssh:typeof f.sshHostKey==='string'&&/^SHA256:[A-Za-z0-9+/]{43}=$/.test(f.sshHostKey),isolation:f.privileged===false&&Array.isArray(f.hostMounts)&&f.hostMounts.length===0&&f.foreignWorkloads===false};
 if(container){checks.toolchain=f.pnpm==='10.28.0'&&f.go==='go1.27.3';checks.rootless=f.rootless===true&&typeof f.engineId==='string'&&!!f.engineId&&f.dockerEndpoint===`unix:///run/user/${f.executorUid}/docker.sock`;}
 return {status:Object.values(checks).every(Boolean)?'PREREQUISITES_SATISFIED':'BLOCKED',checks,workerQualified:false};
}
export function bootstrapPlan(p,a,f,now=Date.now()){
 validateBootstrapAuthorization(a,f,now);const role=roles[p?.role];
 if(!role||p.id!==a.id||p.role!==a.role||p.architecture!==a.architecture||!Array.isArray(p.credentialDomains)||p.credentialDomains.some(x=>!role.domains.includes(x))
  ||!Array.isArray(p.allowedJobs)||!p.allowedJobs.length||p.allowedJobs.some(x=>!/^gromesh-[a-z0-9-]+(?:\/gromesh-[a-z0-9-]+){1,2}$/.test(x)))refuse('role/credential/profile contract');
 const readiness=assessReadiness(p,f);if(readiness.status==='BLOCKED')refuse('prerequisites: '+Object.entries(readiness.checks).filter(([,v])=>!v).map(([k])=>k).join(','));
 return {schema:'gromesh-bootstrap-plan/v1',authorized:true,workerQualified:false,pipelineSha:a.pipelineSha,configFile:role.file,config:{...p,hostname:a.hostname,pipelineSha:a.pipelineSha,enabled:false,publicationEnabled:false,applyEnabled:false,executors:1,mode:'EXCLUSIVE',artifactTransport:{qualified:false,provider:null,maximumArchiveGiB:20},dockerEndpoint:['ci','image-builder'].includes(p.role)?f.dockerEndpoint:null,engineId:['ci','image-builder'].includes(p.role)?f.engineId:null,isolation:{ephemeral:false,privileged:false,hostMounts:[],n2Reachable:null},kongBuildCapacityQualified:false},agent:{name:p.id,label:p.id,hostname:a.hostname,executors:1,mode:'EXCLUSIVE',sshVerification:'MANUALLY_TRUSTED_KEY',hostKeyFingerprint:f.sshHostKey,sshCredentialId:null,register:false},readiness};
}
function memberPath(p){return typeof p==='string'&&/^[A-Za-z0-9][A-Za-z0-9/._-]{0,240}$/.test(p)&&!p.split('/').some(x=>!x||x==='.'||x==='..');}
function bundleFiles(b,plan){
 if(b?.schema!=='gromesh-runtime-bundle/v1'||b.pipelineSha!==plan.pipelineSha||!sha(b.pipelineSha)||!Array.isArray(b.files)||!b.files.length||b.files.length>512)refuse('bundle/revision');
 const seen=new Set();let total=0;const files=[];
 for(const f of b.files){if(!memberPath(f.path)||seen.has(f.path)||f.path==='revision.json')refuse('bundle path');seen.add(f.path);if(![0o444,0o555].includes(f.mode))refuse('bundle mode');
  if(typeof f.data!=='string'||f.data.length>3*1024*1024)refuse('bundle size');const bytes=Buffer.from(f.data,'base64');total+=bytes.length;
  if(bytes.toString('base64')!==f.data||bytes.length>2*1024*1024||total>8*1024*1024||hash(bytes)!==f.sha256)refuse('bundle checksum/size');files.push({...f,bytes});}
 const bytes=Buffer.from(JSON.stringify({sha:b.pipelineSha})+'\n');files.push({path:'revision.json',mode:0o444,sha256:hash(bytes),bytes});return files;
}
async function safeParents(root,path){
 const rel=relative(root,path);if(rel.startsWith('..')||isAbsolute(rel))refuse('path escape');let current=root;
 for(const part of rel.split('/').filter(Boolean)){current=join(current,part);try{await mkdir(current,{mode:0o755});}catch(e){if(e.code!=='EEXIST')throw e;}const s=await lstat(current);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o022)!==0)refuse('symlink or unprotected parent');}
}
async function existingFiles(dir,prefix=''){
 const directory=await lstat(dir);if(!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==process.getuid()||(directory.mode&0o022)!==0)refuse('unprotected runtime directory');
 const out=[];for(const entry of await readdir(dir,{withFileTypes:true})){const name=join(prefix,entry.name),path=join(dir,entry.name);if(entry.isSymbolicLink())refuse('existing runtime symlink');if(entry.isDirectory())out.push(...await existingFiles(path,name));else if(entry.isFile())out.push(name);else refuse('existing special file');}return out;
}
export async function installRuntimeBundle(bundle,root,plan){
 if(plan?.schema!=='gromesh-bootstrap-plan/v1'||plan.authorized!==true||plan.config?.enabled!==false||plan.config.publicationEnabled!==false||plan.config.artifactTransport?.qualified!==false||!Object.values(roles).some(r=>r.file===plan.configFile))refuse('inactive approved plan');
 root=resolve(root);const actual=await realpath(root);if(actual!==root)refuse('fixture root symlink');
 if(root==='/'){if(process.platform!=='linux'||process.getuid()!==0)refuse('real root requires authorized Linux root');}
 else{const temporary=await realpath(tmpdir()),s=await lstat(root);if(dirname(root)!==temporary||!/^gromesh-bootstrap-fixture-[A-Za-z0-9_-]+$/.test(root.split('/').at(-1))||!s.isDirectory()||s.uid!==process.getuid()||(s.mode&0o077)!==0)refuse('private fixture root required');}
 const files=bundleFiles(bundle,plan),target=join(root,'opt/gromesh/jenkins'),etc=join(root,'etc/gromesh-jenkins'),configPath=join(etc,plan.configFile),config=JSON.stringify(plan.config,null,2)+'\n';
 await safeParents(root,dirname(target));await safeParents(root,etc);
 try{const s=await lstat(target);if(!s.isDirectory()||s.isSymbolicLink())refuse('existing runtime path');
  const names=await existingFiles(target);if(names.length!==files.length||files.some(f=>!names.includes(f.path)))refuse('existing or partial runtime');
  for(const f of files){const path=join(target,f.path),stat=await lstat(path);if(stat.uid!==process.getuid()||(stat.mode&0o777)!==f.mode||hash(await readFile(path))!==f.sha256)refuse('existing runtime differs');}
  const stat=await lstat(configPath);if(stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o777)!==0o444||await readFile(configPath,'utf8')!==config)refuse('existing config differs');return {changed:false,workerQualified:false};
 }catch(e){if(e.code!=='ENOENT')throw e;if(await lstat(target).then(()=>true,e=>e.code==='ENOENT'?false:Promise.reject(e)))refuse('existing partial installation');}
 if(await lstat(configPath).then(()=>true,e=>e.code==='ENOENT'?false:Promise.reject(e)))refuse('existing partial configuration');
 const lock=join(etc,'.bootstrap.lock');await writeFile(lock,JSON.stringify({pid:process.pid,pipelineSha:plan.pipelineSha}),{flag:'wx',mode:0o600});
 const staging=join(dirname(target),'.bootstrap-'+randomUUID());
 try{await mkdir(staging,{mode:0o755});for(const f of files){await safeParents(staging,dirname(join(staging,f.path)));await writeFile(join(staging,f.path),f.bytes,{flag:'wx',mode:f.mode});await chmod(join(staging,f.path),f.mode);}
  await rename(staging,target);await writeFile(configPath,config,{flag:'wx',mode:0o444});await chmod(configPath,0o444);return {changed:true,workerQualified:false,files:files.length,config:plan.configFile};
 }finally{await unlink(lock);}
}
export async function buildRuntimeBundle(repo,pipelineSha){
 if(!sha(pipelineSha))refuse('bundle revision');const options={cwd:repo,timeout:30000,maxBuffer:8*1024*1024};
 const paths=(await exec('git',['ls-tree','-r','--name-only',pipelineSha,'--','ci/jenkins'],options)).stdout.trim().split('\n').filter(p=>p&&!p.endsWith('.test.mjs')&&!p.includes('/test-fixtures/')&&!p.includes('/tests/')&&!p.endsWith('_test.py')&&!p.includes('/__pycache__/'));
 if(!paths.includes('ci/jenkins/runner.mjs')||!paths.includes('ci/jenkins/policy.mjs'))refuse('complete runtime required');const files=[];
 for(const path of paths){const row=(await exec('git',['ls-tree',pipelineSha,'--',path],options)).stdout;if(!/^100(?:644|755) blob /.test(row))refuse('runtime symlink/special mode');const bytes=(await exec('git',['show',pipelineSha+':'+path],{...options,encoding:'buffer'})).stdout;files.push({path:path.slice('ci/jenkins/'.length),sha256:hash(bytes),mode:path.endsWith('.sh')?0o555:0o444,data:bytes.toString('base64')});}
 const bundle={schema:'gromesh-runtime-bundle/v1',pipelineSha,files};bundleFiles(bundle,{pipelineSha});return bundle;
}
async function privateRootJson(path,maxBytes=65536){
 if(!path.startsWith('/etc/gromesh-jenkins/')||await realpath(path)!==path)refuse('root-owned authorization location');const s=await lstat(path),p=await lstat(dirname(path));
 if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o077)!==0||s.size>maxBytes||p.uid!==0||(p.mode&0o022)!==0)refuse('root-owned private authorization');
 return {...JSON.parse(await readFile(path,'utf8')),file:{uid:s.uid,mode:s.mode&0o777,symlink:false}};
}
async function identity(executorUid){
 if(platform()!=='linux'||!process.getuid||process.getuid()!==0)refuse('authorized Linux root only');const machineIdHash=hash(await readFile('/etc/machine-id'));
 let hardwareVendor='';for(const p of ['/sys/class/dmi/id/sys_vendor','/proc/device-tree/model'])try{hardwareVendor+=(await readFile(p,'utf8')).slice(0,1024);}catch{}
 return {os:platform(),uid:process.getuid(),hostname:hostname(),architecture:arch()==='x64'?'amd64':arch(),executorUid,machineIdHash,hardwareVendor};
}
export async function protectedExecutable(path){
 if(!isAbsolute(path))refuse('absolute protected executable');
 // Validate the original chain as well as the resolved target; only root can replace accepted links.
 let original=resolve(path);
 while(true){const s=await lstat(original);if(s.uid!==0||(!s.isSymbolicLink()&&(s.mode&0o022)!==0))refuse('unprotected executable path');if(original==='/')break;original=dirname(original);}
 const actual=await realpath(path);let current=actual;
 while(true){const s=await lstat(current);if(s.uid!==0||(s.mode&0o022)!==0||s.isSymbolicLink())refuse('unprotected executable');if(current==='/')break;current=dirname(current);}
 const s=await lstat(actual);if(!s.isFile()||(s.mode&0o111)===0)refuse('executable required');
 return actual;
}
async function collectPrerequisites(f,a){
 const command=async(file,args)=>{try{const protectedPath=await protectedExecutable(file);const r=await exec(protectedPath,args,{timeout:10000,maxBuffer:65536,env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C.UTF-8'}});return r.stdout+r.stderr;}catch{return '';}};
 const {statfs}=await import('node:fs/promises');const disk=await statfs('/opt');const output={...f,kernel:(await command('/usr/bin/uname',['-r'])).trim(),cpus:availableParallelism(),memoryMiB:totalmem()/2**20,diskFreeGiB:Number(disk.bavail)*Number(disk.bsize)/2**30,
  javaMajor:Number((await command('/usr/bin/java',['-version'])).match(/version "(\d+)/)?.[1]),node:(await command('/opt/gromesh/tools/node/bin/node',['--version'])).trim(),pnpm:(await command('/opt/gromesh/tools/bin/pnpm',['--version'])).trim(),go:(await command('/opt/gromesh/tools/bin/go',['version'])).trim().split(' ')[2],proofAuthorityVerified:false};
 const boot=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
 try{const proof=await privateRootJson('/etc/gromesh-jenkins/isolation-proof.json');if(proof.machineIdHash===f.machineIdHash&&proof.bootId===boot&&Date.parse(proof.observedAt)<=Date.now()&&Date.now()-Date.parse(proof.observedAt)<3600000){for(const k of ['resetVerified','n2Denied','dns','ntp','egressTls','diskQuotaEnforced','privileged','hostMounts','foreignWorkloads','delegated'])output[k]=proof[k];output.proofAuthorityVerified=true;}}catch{}
 output.cgroupControllers=(await readFile('/sys/fs/cgroup/cgroup.controllers','utf8').catch(()=>'')).trim().split(/\s+/);output.cgroupVersion=output.cgroupControllers.includes('memory')?2:null;output.systemdDriver=(await readFile('/proc/1/comm','utf8')).trim()==='systemd';
 const pub=(await readFile('/etc/ssh/ssh_host_ed25519_key.pub','utf8').catch(()=>'')).split(/\s+/)[1];output.sshHostKey=pub?'SHA256:'+createHash('sha256').update(Buffer.from(pub,'base64')).digest('base64'):null;
 if(['ci','image-builder'].includes(a.role)){
  const account=(await command('/usr/bin/getent',['passwd',String(f.executorUid)])).trim().split(':');if(Number(account[2])!==f.executorUid)refuse('pre-existing executor account required');const endpoint=`unix:///run/user/${f.executorUid}/docker.sock`;
  try{await protectedExecutable('/usr/bin/docker');await protectedExecutable('/usr/bin/env');const raw=await command('/usr/sbin/runuser',['-u',account[0],'--','/usr/bin/env',`XDG_RUNTIME_DIR=/run/user/${f.executorUid}`,'/usr/bin/docker','--host',endpoint,'info','--format','{{json .}}']);const docker=JSON.parse(raw);output.rootless=docker.SecurityOptions?.includes('name=rootless')===true;output.engineId=docker.ID;output.dockerEndpoint=endpoint;output.cgroupVersion=Number(docker.CgroupVersion);output.systemdDriver=docker.CgroupDriver==='systemd';}catch{}
 }
 return output;
}
async function main(){
 const [operation,authFile,profileFile,bundleFile]=process.argv.slice(2);if(!['check','install'].includes(operation))refuse('usage: check|install /etc/gromesh-jenkins/authorization.json profile.json [bundle.json]');
 const a=await privateRootJson(authFile??'');const f=await identity(a.executorUid);validateBootstrapAuthorization(a,f);const p=await privateRootJson(profileFile??'');const observed=await collectPrerequisites(f,a);const plan=bootstrapPlan(p,a,observed);
 if(operation==='check'){console.log(JSON.stringify({status:'PREREQUISITES_SATISFIED',workerQualified:false,checks:plan.readiness.checks}));return;}
 const b=await privateRootJson(bundleFile??'',12*1024*1024);console.log(JSON.stringify(await installRuntimeBundle(b,'/',plan)));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.log(JSON.stringify({status:'BOOTSTRAP_REFUSED',workerQualified:false}));process.exitCode=78;});
