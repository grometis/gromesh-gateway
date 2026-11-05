const files=['images.yml','kong-image.yml','image-digests.yml'];
const refuse=()=>{throw new Error('Official publisher requires fresh exclusive ownership and explicit cutover authorization');};
// Read-only public metadata; this integration intentionally has no Actions administration permission.
export async function collectPublisherState({transport=fetch,now=Date.now()}={}){
 const workflows=[];
 const get=async path=>{const r=await transport('https://api.github.com/repos/grometis/gromesh-gateway/actions/'+path,{headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},redirect:'error',signal:AbortSignal.timeout(10000)});if(!r.ok)refuse();return r.json();};
 for(const file of files){
  const workflow=await get('workflows/'+file);workflows.push({file,state:workflow.state,activeRuns:0});
 }
 // One repository-wide query per active status, shared by all three publishers.
 // Five full publisher checks plus assembly consume 48 requests rather than 108.
 for(const status of ['queued','in_progress','waiting','requested','pending']){
  const runs=await get('runs?status='+status+'&per_page=100');
  if(!Number.isSafeInteger(runs.total_count)||runs.total_count<0||runs.total_count>100||!Array.isArray(runs.workflow_runs)||runs.workflow_runs.length!==runs.total_count)refuse();
  for(const run of runs.workflow_runs){
   if(typeof run.path!=='string')refuse();
   const workflow=workflows.find(w=>run.path==='.github/workflows/'+w.file);if(workflow)workflow.activeRuns++;
  }
 }
 return {repository:'grometis/gromesh-gateway',observedAt:new Date(now).toISOString(),workflows};
}
export function assertOfficialCutover({cutover,state,pipelineSha,now}){
 if(!cutover||cutover.approved!==true||cutover.pipelineSha!==pipelineSha||!/^[a-f0-9]{40}$/.test(pipelineSha??'')
  ||typeof cutover.authorizedBy!=='string'||!cutover.authorizedBy||!cutover.authorizationId||!Number.isFinite(Date.parse(cutover.authorizedAt))||Date.parse(cutover.authorizedAt)>now
  ||state?.repository!=='grometis/gromesh-gateway'||!Number.isFinite(now)||!Number.isFinite(Date.parse(state.observedAt))||now-Date.parse(state.observedAt)>60000||Date.parse(state.observedAt)>now
  ||!Array.isArray(state.workflows)||state.workflows.length!==files.length||new Set(state.workflows.map(w=>w.file)).size!==files.length
  ||state.workflows.some(w=>!files.includes(w.file)||w.state!=='disabled_manually'||w.activeRuns!==0))refuse();
 return true;
}
