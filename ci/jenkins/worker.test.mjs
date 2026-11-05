import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateWorker } from './worker.mjs';
const facts = () => ({ id: 'dedicated-ci-arm64-01', role: 'ci', os: 'linux', architecture: 'arm64', uid: 1000,
  memoryMiB: 16384, cpus: 8, diskFreeGiB: 100, ephemeral: true, executors: 1,
  docker: { rootless: true, endpoint: 'unix:///run/user/1000/docker.sock', projects: [] },
  credentialDomains: [], n2Reachable: false, privileged: false, hostMounts: [],
  runtime: { ownerUid: 0, mode: 0o555, sha: 'b'.repeat(40) } });
const policy = { id: 'dedicated-ci-arm64-01', role: 'ci', architecture: 'arm64', minimumMemoryMiB: 16384, minimumCpus: 8, minimumDiskGiB: 100, pipelineSha: 'b'.repeat(40) };
test('accepts a dedicated isolated worker for the full suite', () => assert.doesNotThrow(() => validateWorker(policy, facts())));
for (const [name, change] of [
  ['N2 worker identity', f => { f.id = 'gromesh-n2-lab'; }],
  ['Docker Desktop engine', f => { f.docker.endpoint = 'unix:///Users/fabriciogomes/.docker/run/docker.sock'; }],
  ['shared project', f => { f.docker.projects = ['another-project']; }],
  ['root executor', f => { f.uid = 0; }],
  ['too little RAM', f => { f.memoryMiB = 4096; }],
  ['unbounded concurrency', f => { f.executors = 2; }],
  ['publication credentials', f => { f.credentialDomains = ['dockerhub-write']; }],
  ['N2 network route', f => { f.n2Reachable = true; }],
  ['privileged worker container', f => { f.privileged = true; }],
  ['host home mounted', f => { f.hostMounts = ['/Users/fabriciogomes']; }],
  ['pipeline runtime writable by the executor', f => { f.runtime.ownerUid = 1000; }],
  ['group-writable runtime', f => { f.runtime.mode = 0o775; }],
  ['unreviewed runtime revision', f => { f.runtime.sha = 'c'.repeat(40); }],
]) test(`refuses ${name}`, () => { const f = facts(); change(f); assert.throws(() => validateWorker(policy, f)); });
test('a workspace-controlled descriptor cannot qualify the worker',async()=>{
  const d=await mkdtemp(join(tmpdir(),'j5-worker-policy-'));
  try {
    const p=join(d,'worker.json');await writeFile(p,JSON.stringify(policy),{mode:0o600});
    const {inspectWorker}=await import('./worker.mjs');
    assert.equal(typeof inspectWorker,'function');
    await assert.rejects(inspectWorker(p),/root-owned|descriptor|runtime/i);
  } finally {await rm(d,{recursive:true,force:true});}
});
