import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSource, assertCompleteCi, assertPublishable, canonicalHash } from './policy.mjs';

const sha = 'a'.repeat(40), pipelineSha = 'b'.repeat(40);
const source = () => ({ repository: 'grometis/gromesh-gateway', sha, event: 'push', branch: 'main', pr: null, baseSha: null });
const stages = ['install','generated-client','contracts','typecheck','unit-integration','build','charts','ui-acceptance','agent','isolation','compose-e2e','kind-e2e','migration-regression','dependency-scan','image-scan'];
const expected = () => ({ source: source(), pipelineSha, job: 'gromesh-gateway/gromesh-ci/gromesh-main', buildId: '17' });
const report = () => ({ schema: 'gromesh-jenkins-ci/v1', source: source(), pipelineSha,
  build: { job: expected().job, id: '17', url: 'https://jenkins.grometis.com/job/gromesh-gateway/job/gromesh-ci/job/gromesh-main/17/' },
  tools: { node: 'v26.13.0', pnpm: '10.28.0', go: 'go1.27.3' },
  stages: stages.map(id => ({ id, status: 'SUCCESS', exitCode: 0, durationMs: 10, complete:true,tests:{known:true,passed:1,failed:0,skipped:0},artifacts: [{path:'stdout.log',kind:'log',bytes:12,sha256:'a'.repeat(64)},{path:'stderr.log',kind:'log',bytes:0,sha256:'b'.repeat(64)},...(id==='ui-acceptance'?[{path:'screenshots/ui.png',kind:'screenshot',bytes:12,sha256:'c'.repeat(64)}]:[])], ...(id === 'image-scan' ? { platforms: ['linux/amd64','linux/arm64'] } : {}) })) });

test('an exact complete main build is eligible for a separate protected publisher', () => {
  assert.doesNotThrow(() => assertCompleteCi(report(), expected()));
  assert.doesNotThrow(() => assertPublishable(source(), report(), expected()));
});
for (const [name, change] of [
  ['foreign base repository', s => { s.repository = 'attacker/gateway'; }],
  ['short SHA', s => { s.sha = 'a'.repeat(7); }],
  ['shell-bearing branch', s => { s.branch = 'main\nanything'; }],
  ['tag publication', s => { s.event = 'tag'; }],
  ['inconsistent PR metadata', s => { s.pr = 1; }],
]) test(`source refuses ${name}`, () => { const s = source(); change(s); assert.throws(() => validateSource(s)); });
test('PR metadata stays untrusted even for a branch named main', () => {
  const s = { ...source(), event: 'pull_request', pr: 300, baseSha: 'c'.repeat(40) };
  assert.doesNotThrow(() => validateSource(s));
  assert.throws(() => assertPublishable(s, report(), expected()), /PR|publish/i);
});
for (const [name, change] of [
  ['missing integration', r => { r.stages = r.stages.filter(s => s.id !== 'unit-integration'); }],
  ['skipped E2E', r => { r.stages.find(s => s.id === 'kind-e2e').status = 'SKIPPED'; }],
  ['duplicate stage', r => { r.stages.push(r.stages[0]); }],
  ['failed scan', r => { r.stages.find(s => s.id === 'dependency-scan').exitCode = 1; }],
  ['one scan architecture', r => { r.stages.find(s => s.id === 'image-scan').platforms = ['linux/arm64']; }],
  ['another commit', r => { r.source.sha = 'c'.repeat(40); }],
  ['unreviewed pipeline', r => { r.pipelineSha = 'c'.repeat(40); }],
  ['another build', r => { r.build.id = '16'; }],
  ['another job', r => { r.build.job = 'gromesh-gateway/gromesh-ci/gromesh-prs'; }],
  ['local URL', r => { r.build.url = 'http://localhost:18081/job/test/17/'; }],
  ['incorrect build URL', r => { r.build.url = r.build.url.replace('/17/', '/16/'); }],
  ['old Node', r => { r.tools.node = 'v24.20.0'; }],
  ['different pnpm', r => { r.tools.pnpm = '10.20.0'; }],
  ['old Go', r => { r.tools.go = 'go1.26.10'; }],
  ['missing execution evidence',r=>{r.stages[0].artifacts=[];}],
  ['missing UI screenshot',r=>{r.stages.find(s=>s.id==='ui-acceptance').artifacts=r.stages.find(s=>s.id==='ui-acceptance').artifacts.filter(a=>a.kind!=='screenshot');}],
  ['unknown test count',r=>{r.stages.find(s=>s.id==='unit-integration').tests.known=false;}],
  ['truncated logs',r=>{r.stages[0].outputTruncated=true;}],
]) test(`complete CI refuses ${name}`, () => { const r = report(); change(r); assert.throws(() => assertCompleteCi(r, expected())); });
test('canonical hashes ignore object order but distinguish nested artifact changes', () => {
  assert.equal(canonicalHash({ b: 2, a: { z: 1 } }), canonicalHash({ a: { z: 1 }, b: 2 }));
  assert.notEqual(canonicalHash({ a: ['one', 'two'] }), canonicalHash({ a: ['two', 'one'] }));
  assert.throws(() => canonicalHash({ invalid: undefined }));
});
test('PR completeness requires distinct tested merge and head SHAs bound to the base',()=>{
  const r=report();r.source={repository:'grometis/gromesh-gateway',sha:'d'.repeat(40),headSha:sha,event:'pull_request',branch:'feature/ci',pr:300,baseSha:'c'.repeat(40)};
  r.build.job='gromesh-gateway/gromesh-ci/gromesh-prs';r.build.url=r.build.url.replace('gromesh-main','gromesh-prs');
  const e={source:structuredClone(r.source),pipelineSha,job:r.build.job,buildId:'17'};
  assert.doesNotThrow(()=>assertCompleteCi(r,e));
  delete r.source.headSha;delete e.source.headSha;
  assert.throws(()=>assertCompleteCi(r,e),/merge|head/i);
});
