import { lstat,readFile,realpath,statfs } from 'node:fs/promises';
import { availableParallelism,totalmem,hostname } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
const refuse = reason => { throw new Error(`Worker refused: ${reason}`); };
const exec=promisify(execFile);

export function validateWorker(policy, facts) {
  if (!policy || !facts || facts.id !== policy.id || facts.role !== policy.role || facts.architecture !== policy.architecture
      || !/^[a-z0-9-]+$/.test(facts.id) || /gromesh-n2|192\.168\.15\.3|docker-desktop/i.test(facts.id)) refuse('identity');
  if (facts.os !== 'linux' || !Number.isSafeInteger(facts.uid) || facts.uid < 1000 || facts.executors !== 1
      || facts.ephemeral !== true || facts.privileged !== false || facts.n2Reachable !== false
      || !Array.isArray(facts.hostMounts) || facts.hostMounts.length) refuse('isolation');
  if (!/^[a-f0-9]{40}$/.test(policy.pipelineSha ?? '') || facts.runtime?.ownerUid !== 0
      || !Number.isInteger(facts.runtime.mode) || (facts.runtime.mode & 0o022) !== 0
      || facts.runtime.sha !== policy.pipelineSha) refuse('trusted runtime must be immutable to the executor');
  for (const [key, minimum] of [['memoryMiB','minimumMemoryMiB'],['cpus','minimumCpus'],['diskFreeGiB','minimumDiskGiB']])
    if (!Number.isFinite(policy[minimum]) || policy[minimum] <= 0 || !Number.isFinite(facts[key]) || facts[key] < policy[minimum]) refuse('capacity');
  if (!facts.docker?.rootless || facts.docker.endpoint !== `unix:///run/user/${facts.uid}/docker.sock`
      || !Array.isArray(facts.docker.projects) || facts.docker.projects.length) refuse('dedicated rootless engine');
  const domains = { ci: [], 'image-builder': [], 'image-publisher': ['dockerhub-write'], 'cd-plan': ['dev-read'], 'cd-apply': ['dev-write'] };
  if (!domains[facts.role] || !Array.isArray(facts.credentialDomains)
      || facts.credentialDomains.some(c => !domains[facts.role].includes(c))) refuse('credential domain');
  return facts;
}

async function protectedFile(path) {
  const s=await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.uid!==0 || (s.mode&0o022)!==0 || await realpath(path)!==path) refuse('root-owned descriptor/runtime required');
  const parent=await lstat(dirname(path));
  if (!parent.isDirectory() || parent.uid!==0 || (parent.mode&0o022)!==0) refuse('protected descriptor/runtime parent required');
  return s;
}

export async function inspectWorker(policyPath='/etc/gromesh-jenkins/worker.json') {
  if (!policyPath.startsWith('/etc/gromesh-jenkins/')) refuse('root-owned descriptor location required');
  await protectedFile(policyPath);
  const policy=JSON.parse(await readFile(policyPath,'utf8'));
  const runtimeRoot=dirname(fileURLToPath(import.meta.url));
  if (runtimeRoot!=='/opt/gromesh/jenkins') refuse('approved immutable runtime location required');
  const runtimeStat=await protectedFile(join(runtimeRoot,'revision.json'));
  for(const name of ['worker.mjs','ci.mjs','runner.mjs','policy.mjs'])await protectedFile(join(runtimeRoot,name));
  const revision=JSON.parse(await readFile(join(runtimeRoot,'revision.json'),'utf8'));
  if(process.platform!=='linux' || !process.getuid || hostname()!==policy.hostname)refuse('dedicated Linux host required');
  const endpoint=`unix:///run/user/${process.getuid()}/docker.sock`;
  if(policy.dockerEndpoint!==endpoint || process.env.DOCKER_HOST!==endpoint)refuse('explicit dedicated rootless endpoint required');
  const options={timeout:10000,maxBuffer:1024*1024,env:process.env};
  const info=JSON.parse((await exec('docker',['--host',endpoint,'info','--format','{{json .}}'],options)).stdout);
  if(typeof policy.engineId!=='string' || info.ID!==policy.engineId || /gromesh-n2|docker-desktop/i.test(info.Name ?? ''))refuse('Engine identity');
  const rows=(await exec('docker',['--host',endpoint,'ps','-a','--format','{{.ID}}|{{.Label "gromesh.j5.run"}}'],options)).stdout.trim().split('\n').filter(Boolean);
  const foreign=rows.filter(s=>s.split('|')[1]!==process.env.GROMESH_CI_RUN);
  let memoryMiB=totalmem()/2**20;
  try {const limit=(await readFile('/sys/fs/cgroup/memory.max','utf8')).trim();if(limit!=='max')memoryMiB=Math.min(memoryMiB,Number(limit)/2**20);}catch{}
  let cpus=availableParallelism();
  try {const [quota,period]=(await readFile('/sys/fs/cgroup/cpu.max','utf8')).trim().split(' ');if(quota!=='max')cpus=Math.min(cpus,Number(quota)/Number(period));}catch{}
  const disk=await statfs(process.cwd());
  const facts={id:policy.id,role:policy.role,os:process.platform,architecture:process.arch==='x64'?'amd64':process.arch,uid:process.getuid(),
    cpus,memoryMiB,diskFreeGiB:Number(disk.bavail)*Number(disk.bsize)/2**30,executors:policy.executors,
    ephemeral:policy.isolation?.ephemeral,privileged:policy.isolation?.privileged,hostMounts:policy.isolation?.hostMounts,
    n2Reachable:policy.isolation?.n2Reachable,credentialDomains:policy.credentialDomains,
    docker:{rootless:info.SecurityOptions?.includes('name=rootless')===true,endpoint,projects:foreign},
    runtime:{ownerUid:runtimeStat.uid,mode:runtimeStat.mode,sha:revision.sha}};
  validateWorker(policy,facts);
  return {policy,facts};
}
