import test from 'node:test';
import assert from 'node:assert/strict';
import { configureNativeBuilder } from './buildx.mjs';
const policy={rootless:true,driver:'remote',endpoint:'unix:///run/user/1000/buildkit/buildkitd.sock'};
test('creates and inspects an isolated builder under the same configuration used for build',async()=>{
 const calls=[],env={DOCKER_CONFIG:'/workspace/no-creds',GROMESH_CI_RUN:'a'.repeat(32)};
 const clean=await configureNativeBuilder(policy,'arm64','/workspace/builds/17',env,async(argv,options)=>{calls.push({argv,env:options.env});return argv.includes('inspect')?{stdout:JSON.stringify({Driver:'remote',Nodes:[{Endpoint:policy.endpoint,Status:'running',Buildkit:'v0.23.2',Platforms:'linux/arm64'}]})}:{stdout:''};});
 assert.ok(calls[0].argv.includes('create'));assert.ok(calls[0].argv.includes(policy.endpoint));assert.equal(clean.BUILDX_CONFIG,calls[0].env.BUILDX_CONFIG);assert.equal(clean.BUILDX_CONFIG,calls[1].env.BUILDX_CONFIG);assert.notEqual(clean.BUILDX_CONFIG,env.DOCKER_CONFIG+'/buildx');
});
test('actual driver, endpoint, version and native platform must match the protected descriptor',async()=>{
 for(const change of [v=>v.Driver='docker-container',v=>v.Nodes[0].Endpoint='tcp://other:1234',v=>v.Nodes[0].Platforms='linux/amd64',v=>v.Nodes[0].Buildkit='v0.20.0']){
  const info={Driver:'remote',Nodes:[{Endpoint:policy.endpoint,Status:'running',Buildkit:'v0.23.2',Platforms:'linux/arm64'}]};change(info);
  await assert.rejects(configureNativeBuilder(policy,'arm64','/workspace/builds/17',{GROMESH_CI_RUN:'a'.repeat(32)},async argv=>({stdout:argv.includes('inspect')?JSON.stringify(info):''})));
 }
});
