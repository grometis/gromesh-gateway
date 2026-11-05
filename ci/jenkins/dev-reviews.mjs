import https from 'node:https';
// Virtual authentication/authorization reviews only. No workload mutation endpoint is supported here.
export function devReview(connection,target,type,spec={}){
 const routes={identity:['authentication.k8s.io/v1','SelfSubjectReview','/apis/authentication.k8s.io/v1/selfsubjectreviews'],access:['authorization.k8s.io/v1','SelfSubjectAccessReview','/apis/authorization.k8s.io/v1/selfsubjectaccessreviews']};
 const route=routes[type],url=new URL(target.apiServer);
 if(!route||url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('Pinned API review endpoint required');
 const body=JSON.stringify({apiVersion:route[0],kind:route[1],...(type==='access'?{spec}:{})});
 return new Promise((resolve,reject)=>{
  let settled=false;const done=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(new Error('DEV identity/access review failed')):resolve(value);};
  const request=https.request(new URL(route[2],url),{method:'POST',ca:Buffer.from(connection.clusters[0].cluster['certificate-authority-data'],'base64'),rejectUnauthorized:true,
   headers:{Authorization:'Bearer '+connection.users[0].user.token,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},response=>{
   let bytes=0;const chunks=[];response.on('data',b=>{bytes+=b.length;if(bytes>1024*1024)request.destroy(new Error('review budget'));else chunks.push(b);});
   response.on('error',e=>done(e));response.on('end',()=>{if(![200,201].includes(response.statusCode))return done(new Error('review HTTP'));try{done(null,JSON.parse(Buffer.concat(chunks)));}catch(e){done(e);}});
  });
  const timer=setTimeout(()=>request.destroy(new Error('review deadline')),10000);request.on('error',e=>done(e));request.end(body);
 });
}
export async function checkDevAccess(connection,target,role,review=devReview){
 const queries=[
  [{verb:'get',group:'apps',resource:'deployments',name:target.deployment,namespace:target.namespace},true],
  [{verb:'patch',group:'apps',resource:'deployments',name:target.deployment,namespace:target.namespace},role==='apply'],
  [{verb:'patch',group:'apps',resource:'deployments',name:target.release+'-control-plane',namespace:target.namespace},false],
  [{verb:'create',group:'',resource:'pods',namespace:target.namespace},false],
  [{verb:'create',group:'batch',resource:'jobs',namespace:target.namespace},false],
  [{verb:'delete',group:'',resource:'persistentvolumeclaims',namespace:target.namespace},false],
  [{verb:'get',group:'',resource:'secrets',namespace:'kube-system'},false],
  [{verb:'*',group:'*',resource:'*'},false]
 ];
 for(const [resourceAttributes,expected]of queries){const response=await review(connection,target,'access',{resourceAttributes});if(response.status?.allowed!==expected||response.status?.evaluationError)throw new Error('DEV privilege boundary not verified');}
}
