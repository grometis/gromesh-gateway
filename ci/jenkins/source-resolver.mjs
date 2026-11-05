import { readFile,writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { coordinatorClient } from './github-report.mjs';
import { isSha,validateSource } from './policy.mjs';
export async function resolveSource(client,request){
 if(!isSha(request.sha)||!['main','pr','branch'].includes(request.profile))throw new Error('Exact CI source required');
 const source={repository:'grometis/gromesh-gateway',sha:request.sha,event:'manual',branch:'main',pr:null,baseSha:null};
 let comparisonBase;
 if(request.profile==='pr'){
  if(!/^[1-9][0-9]*$/.test(request.pr??''))throw new Error('PR identity required');
  const pr=await client.api('/pulls/'+request.pr);
  if(pr.state!=='open'||pr.base?.repo?.full_name!==source.repository||pr.head?.sha!==request.sha||!isSha(pr.merge_commit_sha)||pr.mergeable===false)throw new Error('PR source changed/unavailable');
  const merge=await client.api('/commits/'+pr.merge_commit_sha),parents=merge.parents?.map(p=>p.sha)??[];
  if(merge.sha!==pr.merge_commit_sha||!parents.includes(pr.head.sha)||!parents.includes(pr.base.sha))throw new Error('PR merge parents changed');
  Object.assign(source,{event:'pull_request',branch:pr.head.ref,pr:pr.number,baseSha:pr.base.sha,headSha:pr.head.sha,sha:pr.merge_commit_sha});comparisonBase=pr.base.sha;
 }else{
  source.branch=request.profile==='main'?'main':request.branch;
  if(request.profile==='branch'&&source.branch==='main')throw new Error('Branch job cannot impersonate main');validateSource(source);
  const compare=await client.api('/compare/'+request.sha+'...'+encodeURIComponent(source.branch));if(compare.merge_base_commit?.sha!==request.sha)throw new Error('SHA outside branch');
  const commit=await client.api('/commits/'+request.sha);if(commit.sha!==request.sha||!isSha(commit.parents?.[0]?.sha))throw new Error('Comparison parent required');comparisonBase=commit.parents[0].sha;
  if(request.fromDiscovery===true)source.event='push';
 }
 validateSource(source);return {source,comparisonBase};
}
async function main(){
 const {client}=await coordinatorClient();
 const profiles={'gromesh-gateway/gromesh-ci/gromesh-main':'main','gromesh-gateway/gromesh-ci/gromesh-prs':'pr','gromesh-gateway/gromesh-ci/gromesh-branches':'branch'};
 const request=JSON.parse(await readFile('source-request.json','utf8'));if(request.profile!==profiles[process.env.JOB_NAME])throw new Error('Trusted CI profile required');
 await writeFile('resolved-source.json',JSON.stringify(await resolveSource(client,request),null,2)+'\n',{mode:0o600});console.log(JSON.stringify({status:'SOURCE_RESOLVED_WITH_REPOSITORY_APP'}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.log(JSON.stringify({status:'SOURCE_RESOLUTION_NOT_CONFIGURED_OR_REFUSED'}));process.exitCode=78;});
