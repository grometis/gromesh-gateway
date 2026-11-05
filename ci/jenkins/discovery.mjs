import { lstat,readFile,writeFile,rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { canonicalHash,validateSource } from './policy.mjs';
import { coordinatorClient } from './github-report.mjs';
const schema='gromesh-jenkins-discovery/v1';
const stateFile='/var/lib/gromesh-jenkins/discovery.json';

function validateState(state) {
  if(state?.schema!==schema||!state.fingerprints||typeof state.fingerprints!=='object'||Array.isArray(state.fingerprints))throw new Error('Invalid discovery state');
  for(const [key,value]of Object.entries(state.fingerprints))
    if(!/^(?:pr:[1-9][0-9]*|branch:[A-Za-z0-9][A-Za-z0-9._/-]{0,199})$/.test(key)||!/^[a-f0-9]{64}$/.test(value))throw new Error('Invalid discovery fingerprint');
}
function candidate(input) {
  validateSource(input);
  if(!['push','pull_request'].includes(input.event))throw new Error('Unexpected discovery event');
  return {repository:input.repository,sha:input.sha,event:input.event,branch:input.branch,pr:input.pr,baseSha:input.baseSha};
}
const keyFor=source=>source.event==='pull_request'?'pr:'+source.pr:'branch:'+source.branch;

export function planDiscovery(inputs,state) {
  validateState(state);
  if(!Array.isArray(inputs)||inputs.length>2000)throw new Error('Discovery list exceeds qualified bound');
  const sources=inputs.map(candidate);
  const prs=new Set(sources.filter(s=>s.event==='pull_request').map(s=>s.branch+':'+s.sha));
  let coveredBranches=0;const pending=[];const seen=new Set();
  for(const source of sources) {
    const key=keyFor(source);
    if(seen.has(key))throw new Error('Duplicate discovered source');seen.add(key);
    if(source.event!=='pull_request'&&source.branch!=='main'&&prs.has(source.branch+':'+source.sha)){coveredBranches++;continue;}
    if(state.fingerprints[key]===canonicalHash(source))continue;
    const job=source.event==='pull_request'?'gromesh-prs':source.branch==='main'?'gromesh-main':'gromesh-branches';
    pending.push({job:'gromesh-gateway/gromesh-ci/'+job,source});
  }
  return {pending:pending.slice(0,20),remaining:Math.max(0,pending.length-20),coveredBranches};
}
export function acknowledgeDiscovery(state,input) {
  validateState(state);const source=candidate(input);
  return {schema,fingerprints:{...state.fingerprints,[keyFor(source)]:canonicalHash(source)}};
}
async function readState() {
  const parent=await lstat('/var/lib/gromesh-jenkins');
  if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.getuid()||(parent.mode&0o077)!==0)throw new Error('Private coordinator state directory required');
  let stat;
  try{stat=await lstat(stateFile);}catch(e){if(e.code==='ENOENT')return {schema,fingerprints:{}};throw e;}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077)!==0||stat.size>2*1024*1024)throw new Error('Invalid state file');
  const state=JSON.parse(await readFile(stateFile,'utf8'));validateState(state);return state;
}
async function main() {
  if(process.env.JOB_NAME!=='gromesh-gateway/gromesh-ci/gromesh-discovery')throw new Error('Unapproved discovery job');
  const {client}=await coordinatorClient();const state=await readState();
  if(process.argv[2]==='list') {
    const plan=planDiscovery(await client.discover(),state);
    await writeFile('discovery-pending.json',JSON.stringify(plan,null,2)+'\n',{mode:0o600});
    console.log(JSON.stringify({pending:plan.pending.length,remaining:plan.remaining,coveredBranches:plan.coveredBranches}));
  } else if(process.argv[2]==='acknowledge') {
    const source=JSON.parse(await readFile('discovery-ack.json','utf8'));
    const next=acknowledgeDiscovery(state,source);const temporary=stateFile+'.'+randomUUID();
    await writeFile(temporary,JSON.stringify(next,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(temporary,stateFile);
    console.log(JSON.stringify({status:'DISPATCH_ACKNOWLEDGED',sha:source.sha,pr:source.pr}));
  } else throw new Error('Unknown discovery command');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.log(JSON.stringify({status:'GITHUB_DISCOVERY_BLOCKED'}));process.exitCode=1;});
