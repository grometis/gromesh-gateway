import { readFile,readdir,lstat,mkdir,copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export const testStages=['unit-integration','ui-acceptance','agent','isolation','compose-e2e','kind-e2e','migration-regression'];
export function sanitize(text,secrets=[]){
 let out=text.replace(/\x1b\[[0-9;]*[A-Za-z]/g,'');
 for(const secret of secrets.filter(s=>typeof s==='string'&&s.length>=4).sort((a,b)=>b.length-a.length))out=out.split(secret).join('[REDACTED]');
 return out.replace(/((?:password|secret|token|authorization|cookie|encryption_key|fingerprint_key)["']?\s*[:=]\s*)[^\s,;]+/gi,'$1[REDACTED]')
  .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|dckr_pat_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,'[REDACTED]')
  .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g,'$1[REDACTED]@');
}
export function summarizeTests(text){
 const totals={passed:0,failed:0,skipped:0,known:false};
 for(const line of text.split('\n')){
  try{const o=JSON.parse(line);if(o.Test&&['pass','fail','skip'].includes(o.Action)){totals[{pass:'passed',fail:'failed',skip:'skipped'}[o.Action]]++;totals.known=true;}continue;}catch{}
  const tap=/(?:#|ℹ)\s*(pass|fail|skipped)\s+(\d+)\s*$/.exec(line);
  if(tap){totals[{pass:'passed',fail:'failed',skipped:'skipped'}[tap[1]]]+=Number(tap[2]);totals.known=true;continue;}
  // Vitest summaries and Playwright result summaries; never count individual assertion lines.
  if(/\bTests\s+|^\s*\d+\s+(passed|failed|skipped)\b/.test(line)){
   for(const m of line.matchAll(/(\d+)\s+(passed|failed|skipped)\b/g)){totals[m[2]]+=Number(m[1]);totals.known=true;}
  }
 }
 return totals;
}
export async function collectEvidence({id,output,cwd,execution}){
 const artifacts=[];let text='';
 const add=async(path,absolute,kind)=>{const s=await lstat(absolute);if(!s.isFile()||s.isSymbolicLink()||s.size>8*1024*1024)return;
  const b=await readFile(absolute);artifacts.push({path,kind,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});if(kind==='log')text+='\n'+b.toString('utf8');};
 for(const name of ['stdout.log','stderr.log'])await add(name,join(output,name),'log');
 if(id==='ui-acceptance'){
  const source=join(cwd,'apps/ui/test-results/screenshots');await mkdir(join(output,'screenshots'),{recursive:true});
  let names=[];try{const s=await lstat(source);if(s.isDirectory()&&!s.isSymbolicLink())names=await readdir(source);}catch{}
  for(const name of names.filter(n=>/^[A-Za-z0-9._-]+\.png$/.test(n)).slice(0,100)){
   const s=await lstat(join(source,name));if(!s.isFile()||s.isSymbolicLink()||s.size>8*1024*1024)continue;
   await copyFile(join(source,name),join(output,'screenshots',name));await add('screenshots/'+name,join(output,'screenshots',name),'screenshot');
  }
 }
 const tests=summarizeTests(text);
 return {artifacts,tests,complete:execution.outputTruncated!==true&&(!testStages.includes(id)||(tests.known&&tests.passed>0&&tests.failed===0))
  &&(id!=='ui-acceptance'||artifacts.some(a=>a.kind==='screenshot'))};
}
