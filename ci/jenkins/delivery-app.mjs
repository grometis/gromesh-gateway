import { appJwt } from './github-app.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,writeFile,unlink,rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exec=promisify(execFile),remote='https://github.com/grometis/gromesh-gateway.git';
const branches=['task/J5-A-jenkins-ci','task/J5-B-dockerhub','task/J5-C-dev-rollback','task/J5-D-transition','task/J6-sync-main'];
const permitted=branch=>branches.includes(branch)||/^task\/J5-digests-[a-f0-9]{40}$/.test(branch??'');
export function deliveryPlan({branch,sha,base,title,body}){
 if(!permitted(branch)||!/^[a-f0-9]{40}$/.test(sha??'')||!['main',...branches].includes(base)||base===branch
  ||typeof title!=='string'||!title.trim()||title.length>200||typeof body!=='string'||body.split('\n').length>10||body.length>8000)throw Error('Repository-scoped reviewed delivery plan required');
 return {repository:'grometis/gromesh-gateway',repositoryId:1421583751,remote,branch,sha,base,title,body,draft:true,force:false,merge:false};
}
export class DeliveryApp {
 #token;#expires=0;
 constructor({appId,installationId,privateKey,transport=fetch}){
  if(!/^[1-9][0-9]*$/.test(appId)||!/^[1-9][0-9]*$/.test(installationId))throw Error('Dedicated delivery App IDs required');
  this.appId=appId;this.installationId=installationId;this.privateKey=privateKey;this.transport=transport;
 }
 async #installationToken(){
  if(this.#token&&Date.now()<this.#expires-60000)return this.#token;
  const r=await this.transport(`https://api.github.com/app/installations/${this.installationId}/access_tokens`,{
   method:'POST',headers:{Authorization:'Bearer '+appJwt(this.appId,this.privateKey),Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},
   body:JSON.stringify({repository_ids:[1421583751],permissions:{metadata:'read',contents:'write',pull_requests:'write'}}),redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw Error('Repository-scoped delivery token refused');
  const data=await r.json();if(typeof data.token!=='string'||!data.token||data.token.length>16384||!Number.isFinite(Date.parse(data.expires_at))||Date.parse(data.expires_at)<=Date.now()+60000)throw Error('Invalid delivery token response');
  this.#token=data.token;this.#expires=Date.parse(data.expires_at);return this.#token;
 }
 async createPr(input){
  const p=deliveryPlan(input),token=await this.#installationToken();
  const r=await this.transport('https://api.github.com/repos/grometis/gromesh-gateway/pulls',{
   method:'POST',headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},
   body:JSON.stringify({head:p.branch,base:p.base,title:p.title,body:p.body,draft:true}),redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw Error('Draft PR creation refused; inspect existing PRs before retry');
  const data=await r.json();if(!Number.isSafeInteger(data.number))throw Error('Invalid PR response');return {number:data.number,url:`https://github.com/grometis/gromesh-gateway/pull/${data.number}`};
 }
 async pushBranch(input,cwd){
  const p=deliveryPlan(input),git=async args=>(await exec('git',args,{cwd,env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',GIT_TERMINAL_PROMPT:'0'},timeout:30000,maxBuffer:65536})).stdout.trim();
  if(await git(['remote','get-url','origin'])!==remote||await git(['rev-parse','refs/heads/'+p.branch])!==p.sha||await git(['status','--porcelain']))throw Error('Preserved clean local branch and exact remote required');
  const directory=await mkdtemp(join(tmpdir(),'gromesh-delivery-')),secret=join(directory,'token'),askpass=join(directory,'askpass');
  try{
   await writeFile(secret,await this.#installationToken(),{mode:0o600,flag:'wx'});
   await writeFile(askpass,'#!'+process.execPath+'\nconst fs=require("node:fs");process.stdout.write(/Username/i.test(process.argv[2]||"")?"x-access-token":fs.readFileSync(process.env.GROMESH_DELIVERY_TOKEN_FILE,"utf8"));\n',{mode:0o700,flag:'wx'});
   await exec('git',['-c','credential.helper=','-c','core.askPass='+askpass,'push',remote,p.sha+':refs/heads/'+p.branch],{
    cwd,env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',GIT_TERMINAL_PROMPT:'0',GIT_ASKPASS:askpass,GROMESH_DELIVERY_TOKEN_FILE:secret},timeout:120000,maxBuffer:65536});
   return {branch:p.branch,sha:p.sha,pushed:true,force:false};
  }catch{throw Error('Task-scoped push refused; local commits and global Git credentials preserved');}
  finally{for(const file of [secret,askpass])try{await unlink(file);}catch(e){if(e.code!=='ENOENT')throw e;}await rmdir(directory);}
 }
}
