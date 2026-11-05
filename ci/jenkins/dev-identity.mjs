import { createHash } from 'node:crypto';
const refuse=()=>{throw new Error('Dedicated scoped DEV ServiceAccount identity required');};
export function assertDevKubeconfig(connection,target,role,now){
 const identity=target?.[role==='plan'?'planIdentity':'applyIdentity'];
 if(!['plan','apply'].includes(role)||!identity||identity.credentialId!==`gromesh-dev-${role}-kubeconfig`||!/^[a-z0-9-]+$/.test(identity.serviceAccount??'')
  ||connection?.clusters?.length!==1||connection?.users?.length!==1)refuse();
 const cluster=connection.clusters[0].cluster,user=connection.users[0].user;
 if(cluster.server!==target.apiServer||cluster['insecure-skip-tls-verify']===true||typeof cluster['certificate-authority-data']!=='string'
  ||createHash('sha256').update(Buffer.from(cluster['certificate-authority-data'],'base64')).digest('hex')!==target.expectedCaSha256
  ||Object.keys(user??{}).some(k=>k!=='token')||typeof user.token!=='string')refuse();
 let claims;try{claims=JSON.parse(Buffer.from(user.token.split('.')[1],'base64url'));}catch{refuse();}
 const username=`system:serviceaccount:${target.namespace}:${identity.serviceAccount}`;
 if(claims.sub!==username||!Number.isFinite(now)||!Number.isSafeInteger(claims.exp)||claims.exp*1000<=now+120000||claims.exp*1000>now+930000)refuse();
 // This checks metadata only. Production immediately authenticates it using SelfSubjectReview over pinned TLS.
 return username;
}
export function assertDevRules(review,role,deployment){
 // Advisory qualification audit only. Runtime authorization is delegated to live SelfSubjectAccessReviews and RBAC.
 if(review?.status?.incomplete!==false||!Array.isArray(review.status.resourceRules))refuse();
 for(const rule of review.status.resourceRules){
  if(!Array.isArray(rule.verbs)||!Array.isArray(rule.apiGroups)||!Array.isArray(rule.resources)||[...rule.verbs,...rule.apiGroups,...rule.resources].includes('*'))refuse();
  for(const verb of rule.verbs){
   if(['get','list','watch'].includes(verb))continue;
   const selfReview=verb==='create'&&rule.resources.every(r=>['selfsubjectreviews','selfsubjectaccessreviews','selfsubjectrulesreviews'].includes(r))&&rule.apiGroups.every(g=>['authentication.k8s.io','authorization.k8s.io'].includes(g));
   const ui=role==='apply'&&['update','patch'].includes(verb)&&rule.apiGroups.every(g=>g==='apps')&&rule.resources.every(r=>r==='deployments')&&rule.resourceNames?.length===1&&rule.resourceNames[0]===deployment;
   const helmStorage=role==='apply'&&['create','update','patch'].includes(verb)&&rule.apiGroups.every(g=>g==='')&&rule.resources.every(r=>r==='secrets');
   if(!selfReview&&!ui&&!helmStorage)refuse();
  }
 }
 return true;
}
