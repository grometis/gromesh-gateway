import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertDevKubeconfig,assertDevRules } from './dev-identity.mjs';
test('only short-lived dedicated SA tokens with the approved server/CA are accepted before API access',()=>{
 const now=Date.now(),ca=Buffer.from('fixture-public-CA'),target={namespace:'dev',apiServer:'https://dev.example.test:6443',expectedCaSha256:createHash('sha256').update(ca).digest('hex'),planIdentity:{serviceAccount:'jenkins-plan',credentialId:'gromesh-dev-plan-kubeconfig'},applyIdentity:{serviceAccount:'jenkins-apply',credentialId:'gromesh-dev-apply-kubeconfig'}};
 const token='fixture.'+Buffer.from(JSON.stringify({sub:'system:serviceaccount:dev:jenkins-plan',exp:Math.floor(now/1000)+600})).toString('base64url')+'.not-a-real-signature';
 const connection={clusters:[{cluster:{server:target.apiServer,'certificate-authority-data':ca.toString('base64')}}],users:[{user:{token}}]};
 assert.equal(assertDevKubeconfig(connection,target,'plan',now),'system:serviceaccount:dev:jenkins-plan');
 for(const change of [c=>c.users[0].user.exec={command:'arbitrary'},c=>c.users[0].user['client-key-data']='forbidden',c=>c.clusters[0].cluster.server='https://other.example.test',c=>c.clusters[0].cluster['insecure-skip-tls-verify']=true]){const c=structuredClone(connection);change(c);assert.throws(()=>assertDevKubeconfig(c,target,'plan',now));}
 assert.throws(()=>assertDevKubeconfig(connection,target,'apply',now));assert.throws(()=>assertDevKubeconfig(connection,target,'plan',now+900000));
});
test('wildcard/admin permissions and PLAN write permissions are rejected',()=>{
 const read={status:{incomplete:false,resourceRules:[{verbs:['get','list','watch'],apiGroups:['apps'],resources:['deployments']}]}};
 assert.doesNotThrow(()=>assertDevRules(read,'plan','cp-control-plane-ui'));
 for(const verbs of [['*'],['create'],['patch']])assert.throws(()=>assertDevRules({status:{incomplete:false,resourceRules:[{verbs,apiGroups:['*'],resources:['*']}]}},'plan','cp-control-plane-ui'));
 assert.throws(()=>assertDevRules({status:{incomplete:false,resourceRules:[{verbs:['patch'],apiGroups:['apps'],resources:['deployments'],resourceNames:['cp-control-plane']}]}},'apply','cp-control-plane-ui'));
});
