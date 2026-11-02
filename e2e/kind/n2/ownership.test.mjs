import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import * as guard from '../../../scripts/kind-stack-guard.mjs';

const label = 'com.grometis.gromesh.n2-run';
const lab = 'com.grometis.gromesh.lab';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'n2-ownership-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { LAB_KUBECONFIG: join(dir, 'config'), LAB_RUN_ID: 'run-123456789abc', HOME: join(dir, 'home') };
  const calls = [], objects = new Map(), containers = new Map(), images = new Map(), volumes = new Map();
  let failOn = null, helmManifest = [];
  let created = false, ca = 'Y2E=', uid = 'system-original', context = 'kind-gromesh-n2-lab';
  const node = { Name: '/gromesh-n2-lab-control-plane', Id: 'node-original', Config: { Labels: { 'io.x-k8s.kind.cluster': 'gromesh-n2-lab' } }, State: { Running: true }, Mounts: [], NetworkSettings: { Ports: { '6443/tcp': [{ HostPort: '12345', HostIp: '127.0.0.1' }] } } };
  const metadata = (name, id = name) => ({ name, uid: id, labels: { [label]: env.LAB_RUN_ID, [lab]: 'n2' } });
  const execute = async (cmd, args, options = {}) => {
    calls.push({ cmd, args, input: options.input });
    if (failOn && failOn(cmd, args)) throw Error('fixture inspection unavailable');
    let stdout = '';
    if (cmd === 'docker') {
      if (args[0] === 'context') stdout = JSON.stringify([{ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }]);
      else if (args[0] === 'ps') {
        let live = [...containers.values(), ...(created ? [node] : [])];
        const filter = args[args.indexOf('--filter') + 1];
        if (args.includes('--filter') && filter.startsWith('label=io.x-k8s.kind.cluster=')) live = live.filter(c => c.Config.Labels['io.x-k8s.kind.cluster'] === 'gromesh-n2-lab');
        if (args.includes('--filter') && filter.startsWith('name=')) live = live.filter(c => c.Name === filter.slice('name=^'.length, -1));
        stdout = live.map(c => c.Id).join('\n');
      } else if (args[0] === 'inspect') stdout = JSON.stringify(args.slice(1).map(id => [node, ...containers.values()].find(c => c.Id === id || c.Name === '/' + id)));
      else if (args[0] === 'volume') stdout = args[1] === 'ls' ? [...volumes.keys()].join('\n') : JSON.stringify([volumes.get(args[2])]);
      else if (args[0] === 'image') {
        if (args[1] === 'ls') stdout = [...images.keys()].join('\n');
        else if (args[1] === 'inspect') stdout = JSON.stringify([images.get(args[2]) ?? { Id: 'source', Config: {} }]);
        else if (args[1] === 'rm') images.delete(args[2]);
        else throw Error('unexpected image call');
      } else if (args[0] === 'pull') stdout = '';
      else if (args[0] === 'tag') images.set(args[2], structuredClone(images.get(args[1]) ?? { Id: 'source', Config: {} }));
      else if (args[0] === 'build') {
        const tag = args[args.indexOf('-t') + 1];
        images.set(tag, { Id: 'built-' + tag, Config: { Labels: Object.fromEntries(args.flatMap((a, i) => a === '--label' ? [args[i + 1].split('=')] : [])) } });
      } else if (args[0] === 'run') {
        const name = args[args.indexOf('--name') + 1];
        const labels = Object.fromEntries(args.flatMap((a, i) => a === '--label' ? [args[i + 1].split('=')] : []));
        containers.set(name, { Id: 'created-' + name, Name: '/' + name, Config: { Labels: labels } });
        stdout = 'created-' + name;
      } else if (args[0] === 'rm') {
        const pair = [...containers].find(([, c]) => c.Id === args.at(-1)); if (pair) containers.delete(pair[0]);
      }
      else throw Error('unexpected Docker call ' + args.join(' '));
    } else if (cmd === 'kind') {
      if (args[0] === 'create') { created = true; writeFileSync(env.LAB_KUBECONFIG, 'exclusive config'); }
      else if (args[0] === 'get' && args[1] === 'clusters') stdout = created ? 'gromesh-n2-lab' : '';
      else if (args[0] === 'get' && args[1] === 'kubeconfig') stdout = 'kind config';
      else if (args[0] === 'delete') created = false;
      else throw Error('unexpected kind call');
    } else if (cmd === 'kubectl') {
      const a = args.slice(args.indexOf('--context') + 2);
      if (a[0] === 'config') stdout = JSON.stringify({ 'current-context': context, contexts: [{ name: context, context: { cluster: context } }], clusters: [{ name: context, cluster: { server: 'https://127.0.0.1:12345', 'certificate-authority-data': ca } }] });
      else if (a[0] === 'get') {
        const type = a[1], name = a[2]?.startsWith('-') ? undefined : a[2];
        if (type === 'namespace' && name === 'kube-system') stdout = JSON.stringify({ kind: 'Namespace', metadata: metadata('kube-system', uid) });
        else if (type === 'namespace' && !name) stdout = JSON.stringify({ items: [{ kind: 'Namespace', metadata: metadata('kube-system', uid) }, ...[...objects.values()].filter(o => o.kind === 'Namespace')] });
        else if (type === 'pvc') stdout = JSON.stringify({ items: [...objects.values()].filter(o => o.kind === 'PersistentVolumeClaim') });
        else if (type === 'configmap' || type === 'deployment') stdout = JSON.stringify({ kind: type, metadata: metadata(name) });
        else stdout = JSON.stringify(name ? objects.get(`${type.toLowerCase()}/${name}`) ?? null : { items: [...objects.values()].filter(o => o.kind.toLowerCase() === type.toLowerCase()) });
      } else if (a.includes('--dry-run=client')) stdout = options.input;
      else if (['create', 'apply'].includes(a[0])) {
        const obj = JSON.parse(options.input);
        obj.metadata.uid ??= 'created-' + obj.metadata.name;
        objects.set(`${obj.kind.toLowerCase()}/${obj.metadata.name}`, obj);
        stdout = JSON.stringify(obj);
      } else if (a[0] === 'delete') {
        assert.equal(a[1], '--raw');
        const name = a[2].split('/').at(-1);
        const key = [...objects.keys()].find(k => k.endsWith('/' + name));
        assert.equal(JSON.parse(options.input).preconditions.uid, objects.get(key)?.metadata.uid);
        objects.delete(key);
      } else if (!['label', 'annotate', 'patch', 'wait'].includes(a[0])) throw Error('unexpected kubectl call ' + a.join(' '));
    } else if (cmd === 'helm') stdout = JSON.stringify({ apiVersion: 'v1', kind: 'List', items: helmManifest });
    else throw Error('unexpected executable ' + cmd);
    return { code: 0, stdout, stderr: '' };
  };
  const owner = () => new guard.N2Lab({ env, execute });
  return { env, calls, objects, containers, images, volumes, node, metadata, owner, dir, execute, fail: fn => { failOn = fn; }, helm: objects => { helmManifest = objects; }, setCA: v => { ca = v; }, setUID: v => { uid = v; }, setContext: v => { context = v; } };
}
const ns = name => ({ apiVersion: 'v1', kind: 'Namespace', metadata: { name } });
const mutations = calls => calls.filter(c => !c.args.includes('--dry-run=client')).filter(c => c.cmd === 'helm' ? c.args.some(a => ['install', 'upgrade', 'uninstall'].includes(a)) : c.cmd === 'kind' ? ['create', 'delete', 'load'].includes(c.args[0]) : c.cmd === 'docker' ? (['rm', 'run', 'build', 'tag', 'pull'].includes(c.args[0]) || (c.args[0] === 'image' && c.args[1] === 'rm')) : c.args.some(a => ['apply', 'create', 'delete', 'patch', 'label', 'annotate'].includes(a)));

for (const [name, change] of [['UID', f => f.setUID('replaced')], ['CA', f => f.setCA('Zm9yZWlnbg==')], ['context', f => f.setContext('wrong')]]) {
  test(`same cluster name with different ${name} refuses without mutation and preserves evidence`, async t => {
    const f = fixture(t), owner = f.owner();
    await owner.createCluster('kind fixture');
    const evidence = join(f.dir, 'results.json'); writeFileSync(evidence, 'evidence');
    const proof = readFileSync(owner.statePath, 'utf8');
    f.calls.length = 0; change(f);
    await assert.rejects(owner.destroyCluster(), /N2.*refused/);
    assert.equal(mutations(f.calls).length, 0);
    assert.equal(readFileSync(evidence, 'utf8'), 'evidence');
    assert.equal(readFileSync(owner.statePath, 'utf8'), proof);
  });
}
test('preexisting namespace without ownership is never adopted or deleted', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('kind fixture');
  f.objects.set('namespace/gromesh-dp', { ...ns('gromesh-dp'), metadata: { name: 'gromesh-dp', uid: 'foreign' } });
  f.calls.length = 0;
  await assert.rejects(owner.kubectl(['delete', 'namespace', 'gromesh-dp', '--ignore-not-found']), /N2.*refused/);
  assert.equal(mutations(f.calls).length, 0);
});
test('foreign PVC prevents namespace and cluster deletion before either mutates', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('kind fixture');
  await owner.kubectl(['apply', '-f', '-'], { input: JSON.stringify(ns('gromesh-dp')) });
  f.objects.set('persistentvolumeclaim/foreign', { kind: 'PersistentVolumeClaim', metadata: { name: 'foreign', namespace: 'gromesh-dp', uid: 'foreign' } });
  f.calls.length = 0;
  await assert.rejects(owner.kubectl(['delete', 'namespace', 'gromesh-dp']), /N2.*refused/);
  assert.equal(mutations(f.calls).length, 0);
  await assert.rejects(f.owner().destroyCluster(), /N2.*refused/);
  assert.equal(mutations(f.calls).length, 0);
});
test('global kubeconfig and wrong run id refuse before any subprocess', async t => {
  const f = fixture(t);
  for (const config of [join(f.env.HOME, '.kube/config'), '/tmp/config:/tmp/other']) {
    const o = new guard.N2Lab({ env: { ...f.env, LAB_KUBECONFIG: config }, execute: async () => { throw Error('must not execute'); } });
    await assert.rejects(o.createCluster('fixture'), /N2.*refused/);
  }
  const owner = f.owner(); await owner.createCluster('fixture');
  f.calls.length = 0;
  await assert.rejects(new guard.N2Lab({ env: { ...f.env, LAB_RUN_ID: 'other-123456789' }, execute: async () => { throw Error('must not execute'); } }).assertIdentity(), /N2.*refused/);
});
test('happy path creates labelled resources, proves ownership and cleans its namespace and cluster', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  await owner.kubectl(['apply', '-f', '-'], { input: JSON.stringify(ns('gromesh-dp')) });
  assert.equal(f.objects.get('namespace/gromesh-dp').metadata.labels[label], f.env.LAB_RUN_ID);
  await owner.kubectl(['delete', 'namespace', 'gromesh-dp']);
  await owner.destroyCluster();
  assert.ok(f.calls.some(c => c.cmd === 'kind' && c.args[0] === 'delete'));
});

test('a namespace with copied run labels but no creation receipt is also refused', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  f.objects.set('namespace/gromesh-dp', { ...ns('gromesh-dp'), metadata: f.metadata('gromesh-dp', 'copied') });
  f.calls.length = 0;
  await assert.rejects(owner.kubectl(['apply', '-f', '-'], { input: JSON.stringify(ns('gromesh-dp')) }), /N2.*refused/);
  assert.equal(mutations(f.calls).length, 0);
});
test('a preexisting fixture is never removed by its fixed name', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  f.containers.set('gromesh-n2-lab-fx-backend', { Id: 'foreign', Name: '/gromesh-n2-lab-fx-backend', Config: { Labels: {} } });
  f.calls.length = 0;
  await assert.rejects(owner.docker(['rm', '-f', 'gromesh-n2-lab-fx-backend'], { allowFail: true }), /N2.*refused/);
  assert.equal(mutations(f.calls).length, 0);
});
test('own fixture container is labelled, recorded and removed by ID', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  const name = 'gromesh-n2-lab-fx-backend';
  await owner.docker(['run', '-d', '--name', name, '--network', 'kind', 'fixture@sha256:' + 'a'.repeat(64), 'node']);
  assert.equal(f.containers.get(name).Config.Labels[label], f.env.LAB_RUN_ID);
  assert.ok(f.calls.findIndex(c => c.cmd === 'docker' && c.args[0] === 'pull') < f.calls.findIndex(c => c.cmd === 'docker' && c.args[0] === 'run'));
  await owner.docker(['rm', '-f', name]);
  assert.equal(f.containers.size, 0);
  assert.deepEqual(f.calls.findLast(c => c.cmd === 'docker' && c.args[0] === 'rm').args, ['rm', '-f', 'created-' + name]);
});
test('preexisting image aliases are refused without overwriting or deleting them', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  const tag = 'lab:' + f.env.LAB_RUN_ID;
  f.images.set(tag, { Id: 'preexisting', Config: {} });
  f.calls.length = 0;
  await assert.rejects(owner.image(['tag', 'source', tag]), /N2.*refused/);
  assert.equal(mutations(f.calls).length, 0);
  assert.equal(f.images.get(tag).Id, 'preexisting');
});
test('image cleanup removes only recorded aliases and keeps the original source image', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  f.images.set('source', { Id: 'source', RepoTags: ['source'], Config: {} });
  await owner.image(['tag', 'source', 'lab:' + f.env.LAB_RUN_ID]);
  await owner.image(['build', '-t', 'built:' + f.env.LAB_RUN_ID, '.']);
  await owner.image(['clean']);
  assert.deepEqual([...f.images.keys()], ['source']);
  assert.ok(f.calls.filter(c => c.cmd === 'docker' && c.args[1] === 'rm').every(c => !c.args.includes('--force') && !c.args.includes('source')));
});
test('an image alias replaced after creation refuses cleanup and preserves the receipt', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  const tag = 'lab:' + f.env.LAB_RUN_ID;
  await owner.image(['tag', 'source', tag]);
  f.images.set(tag, { Id: 'replacement', Config: {} });
  const receipt = readFileSync(owner.statePath, 'utf8'); f.calls.length = 0;
  await assert.rejects(owner.image(['clean']), /N2.*refused/);
  assert.equal(mutations(f.calls).length, 0);
  assert.equal(readFileSync(owner.statePath, 'utf8'), receipt);
});
test('changed node mounts refuse cluster deletion before any resource is touched', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  f.node.Mounts.push({ Type: 'volume', Name: 'foreign', Source: '/foreign', Destination: '/var' });
  f.calls.length = 0;
  await assert.rejects(owner.destroyCluster(), /N2.*refused/);
  assert.equal(mutations(f.calls).length, 0);
});
test('a failed PVC inspection is never interpreted as absence', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  await owner.kubectl(['apply', '-f', '-'], { input: JSON.stringify(ns('gromesh-dp')) });
  f.fail((cmd, args) => cmd === 'kubectl' && args.includes('pvc'));
  f.calls.length = 0;
  await assert.rejects(owner.kubectl(['delete', 'namespace', 'gromesh-dp']));
  assert.equal(mutations(f.calls).length, 0);
});

for (const scenario of ['UID', 'CA', 'context', 'namespace', 'PVC', 'happy']) {
  test(`cluster.sh down with fixture executables: ${scenario}`, async t => {
    const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
    if (scenario === 'PVC') await owner.kubectl(['apply', '-f', '-'], { input: JSON.stringify(ns('gromesh-dp')) });
    const bin = join(f.dir, 'bin'); mkdirSync(bin);
    const record = join(f.dir, 'calls.jsonl'); writeFileSync(record, '');
    const results = join(f.dir, 'results.json'); writeFileSync(results, '{"evidence":"kept"}');
    const config = { 'current-context': scenario === 'context' ? 'wrong' : 'kind-gromesh-n2-lab',
      contexts: [{ context: { cluster: 'kind-gromesh-n2-lab' } }],
      clusters: [{ cluster: { server: 'https://127.0.0.1:12345', 'certificate-authority-data': scenario === 'CA' ? 'cmVwbGFjZWQ=' : 'Y2E=' } }] };
    const system = { apiVersion: 'v1', kind: 'Namespace', metadata: f.metadata('kube-system', scenario === 'UID' ? 'replacement' : 'system-original') };
    const namespaces = [system, ...[...f.objects.values()].filter(o => o.kind === 'Namespace')];
    if (scenario === 'namespace') namespaces.push({ ...ns('foreign'), metadata: { name: 'foreign', uid: 'foreign' } });
    const pvcs = scenario === 'PVC' ? [{ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'foreign', namespace: 'gromesh-dp', uid: 'foreign' } }] : [];
    const data = join(f.dir, 'fixture.json');
    writeFileSync(data, JSON.stringify({ config, system, node: f.node, namespaces, pvcs, record }));
    const fake = String.raw`#!${process.execPath}
import { readFileSync, appendFileSync } from 'node:fs';
const f = JSON.parse(readFileSync(process.env.N2_FIXTURE));
const cmd = process.argv[1].split('/').at(-1), args = process.argv.slice(2);
appendFileSync(f.record, JSON.stringify({ cmd, args }) + '\n');
const json = o => console.log(JSON.stringify(o));
if (cmd === 'docker' && args[0] === 'context') json([{ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }]);
else if (cmd === 'docker' && args[0] === 'ps') console.log('node-original');
else if (cmd === 'docker' && args[0] === 'inspect') json([f.node]);
else if (cmd === 'kind' && args[0] === 'get') console.log('kind fixture');
else if (cmd === 'kind' && args[0] === 'delete') console.log('deleted own fixture cluster');
else if (cmd === 'kubectl' && args.includes('config')) json(f.config);
else if (cmd === 'kubectl' && args.includes('get')) {
  const a = args.slice(args.indexOf('get') + 1);
  if (a[0] === 'namespace') json(a[1] === 'kube-system' ? f.system : a[1] === 'gromesh-dp' ? f.namespaces.find(n => n.metadata.name === a[1]) : { items: f.namespaces });
  else if (a[0] === 'pvc') json({ items: f.pvcs });
  else throw Error('unexpected resource ' + a[0]);
} else throw Error('unexpected fixture executable call ' + cmd + ' ' + args);
`;
    for (const command of ['docker', 'kind', 'kubectl', 'helm']) {
      const file = join(bin, command); writeFileSync(file, fake); chmodSync(file, 0o755);
    }
    const proof = readFileSync(owner.statePath, 'utf8');
    const result = (() => {
      try { return { code: 0, stdout: execFileSync('bash', [new URL('./cluster.sh', import.meta.url).pathname, 'down'], { encoding: 'utf8', env: { ...process.env, ...f.env, PATH: bin + ':' + process.env.PATH, N2_FIXTURE: data }, stdio: ['ignore', 'pipe', 'pipe'] }) }; }
      catch (e) { return { code: e.status, stderr: String(e.stderr) }; }
    })();
    const calls = readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(result.code, scenario === 'happy' ? 0 : 1, result.stderr + '\n' + JSON.stringify(calls));
    assert.ok(calls.some(c => c.cmd === 'kubectl' && c.args.includes('config')), 'identity must reach fixture kubectl');
    assert.equal(mutations(calls).length, scenario === 'happy' ? 1 : 0);
    assert.equal(readFileSync(results, 'utf8'), '{"evidence":"kept"}');
    assert.equal(readFileSync(owner.statePath, 'utf8'), proof);
    assert.ok(calls.every(c => ['docker', 'kind', 'kubectl'].includes(c.cmd)));
  });
}

test('a PVC created by this run is labelled, recorded and removable with its namespace', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  await owner.kubectl(['apply', '-f', '-'], { input: JSON.stringify(ns('gromesh-dp')) });
  const pvc = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'own', namespace: 'gromesh-dp' }, spec: {} };
  await owner.kubectl(['create', '-f', '-'], { input: JSON.stringify(pvc) });
  await owner.kubectl(['delete', 'namespace', 'gromesh-dp']);
  assert.ok(f.calls.some(c => c.cmd === 'kubectl' && c.args.includes('/api/v1/namespaces/gromesh-dp')));
});
test('Helm hook name collision refuses before a Job or release can be changed', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  await owner.kubectl(['apply', '-f', '-'], { input: JSON.stringify(ns('gromesh-dp')) });
  const hook = { apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'schema', namespace: 'gromesh-dp', annotations: { 'helm.sh/hook': 'pre-install,pre-upgrade' } }, spec: { template: { metadata: {}, spec: {} } } };
  f.helm([hook]);
  f.objects.set('job/schema', { ...hook, metadata: { ...hook.metadata, uid: 'foreign' } });
  f.calls.length = 0;
  await assert.rejects(owner.helm(['install', 'dp', 'chart', '-n', 'gromesh-dp']), /N2.*refused/);
  assert.equal(mutations(f.calls).length, 0);
});
test('Helm stamps pod templates and runs its schema Job with guarded UID cleanup', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  await owner.kubectl(['apply', '-f', '-'], { input: JSON.stringify(ns('gromesh-dp')) });
  const hook = { apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'schema', namespace: 'gromesh-dp', annotations: { 'helm.sh/hook': 'pre-install,pre-upgrade' } }, spec: { template: { metadata: {}, spec: {} } } };
  f.helm([hook]);
  await owner.helm(['install', 'dp', 'chart', '-n', 'gromesh-dp']);
  const create = f.calls.find(c => c.cmd === 'kubectl' && c.input?.includes('"kind":"Job"') && !c.args.includes('--dry-run=client'));
  assert.equal(JSON.parse(create.input).spec.template.metadata.labels[label], f.env.LAB_RUN_ID);
  assert.equal(f.objects.has('job/schema'), false);
  assert.ok(f.calls.some(c => c.cmd === 'helm' && c.args.includes('install') && c.args.includes('--no-hooks') && c.args.includes('--post-renderer')));
});
test('component finish preserves its report when identity refusal also prevents thawing', async () => {
  const source = readFileSync(new URL('./components/v2.mjs', import.meta.url), 'utf8');
  const finish = source.slice(source.indexOf('let finishedV2 = false;'), source.indexOf('const clients = [];'));
  const report = {}; let saves = 0;
  await runInNewContext(finish + '\nfinishV2()', {
    report, ownership: { refused: true }, thawAll: async () => { throw Error('identity refused'); }, followers: [], clients: [], ctx: { owned: true },
    frozen: new Set(), save: () => { saves++; }, secretScanV2: () => ({ leaks: [] }), log: () => {},
  });
  assert.equal(saves, 2);
  assert.equal(report.cleanupFailed, true);
  assert.match(report.cleanup, /evidence preserved/);
});

test('editing the exclusive kubeconfig invalidates the receipt before any executable runs', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  writeFileSync(f.env.LAB_KUBECONFIG, 'a different context or authentication plugin');
  f.calls.length = 0;
  await assert.rejects(owner.assertIdentity(), /N2.*refused/);
  assert.equal(f.calls.length, 0);
});
test('a changed kind node ID refuses mutations even if endpoint, CA and namespace UID still match', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  f.node.Id = 'replacement-node'; f.calls.length = 0;
  await assert.rejects(owner.destroyCluster(), /N2.*refused/);
  assert.equal(mutations(f.calls).length, 0);
});
test('a copied ownership label cannot authorize deletion of an unrecorded cluster policy', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  f.objects.set('ciliumclusterwidenetworkpolicy/policy', { apiVersion: 'cilium.io/v2', kind: 'CiliumClusterwideNetworkPolicy', metadata: f.metadata('policy', 'foreign') });
  f.calls.length = 0;
  await assert.rejects(owner.kubectl(['delete', 'ciliumclusterwidenetworkpolicy', 'policy']), /N2.*refused/);
  assert.equal(mutations(f.calls).length, 0);
});

test('up refuses an existing cluster instead of adopting it with a fresh kubeconfig path', async t => {
  const f = fixture(t); await f.owner().createCluster('fixture');
  const other = new guard.N2Lab({ env: { ...f.env, LAB_KUBECONFIG: join(f.dir, 'fresh-config') }, execute: f.execute });
  f.calls.length = 0;
  await assert.rejects(other.createCluster('fixture'), /N2.*refused/);
  assert.equal(mutations(f.calls).length, 0);
});
test('node volumes are recorded at creation and replacement volumes refuse cleanup', async t => {
  const f = fixture(t);
  f.node.Mounts = [{ Type: 'volume', Name: 'new-node-volume', Source: '/docker/new-node-volume', Destination: '/var' }];
  const execute = async (cmd, args, options) => {
    if (cmd === 'kind' && args[0] === 'create') f.volumes.set('new-node-volume', { Name: 'new-node-volume', CreatedAt: 'original', Driver: 'local', Labels: {} });
    return f.execute(cmd, args, options);
  };
  const owner = new guard.N2Lab({ env: f.env, execute }); await owner.createCluster('fixture');
  assert.equal(JSON.parse(readFileSync(owner.statePath, 'utf8')).volumes['new-node-volume'].CreatedAt, 'original');
  f.volumes.get('new-node-volume').CreatedAt = 'replacement'; f.calls.length = 0;
  await assert.rejects(owner.destroyCluster(), /N2.*refused/);
  assert.equal(mutations(f.calls).length, 0);
});
test('incomplete creation that mounted a preexisting volume never attempts rollback deletion', async t => {
  const f = fixture(t);
  f.volumes.set('foreign', { Name: 'foreign', Driver: 'local', CreatedAt: 'before' });
  f.node.Mounts = [{ Type: 'volume', Name: 'foreign', Source: '/docker/foreign', Destination: '/var' }];
  const owner = f.owner();
  await assert.rejects(owner.createCluster('fixture'), /N2.*refused/);
  assert.ok(f.volumes.has('foreign'));
  assert.equal(JSON.parse(readFileSync(owner.statePath, 'utf8')).phase, 'creating');
  assert.ok(!f.calls.some(c => c.args.includes('delete') || c.args.includes('rm')));
});

for (const target of ['observer', 'probe', 'control-plane']) {
  test(`raw kubectl spawn refuses a foreign replacement ${target} inside an owned namespace`, async t => {
    const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
    const namespace = 'own-namespace';
    await owner.kubectl(['apply', '-f', '-'], { input: JSON.stringify(ns(namespace)) });
    const kind = target === 'control-plane' ? 'Service' : 'Pod';
    f.objects.set(`${kind.toLowerCase()}/${target}`, { apiVersion: 'v1', kind, metadata: { name: target, namespace, uid: 'foreign' } });
    const source = readFileSync(new URL(target === 'observer' ? './components/v2.mjs' : target === 'probe' ? './run.mjs' : './components/lab.mjs', import.meta.url), 'utf8');
    let body;
    if (target === 'observer') body = 'class Client { ' + source.slice(source.indexOf('static async start('), source.indexOf('  constructor(label, args)')) + ' constructor() { spawn(); } }; await Client.start()';
    else if (target === 'probe') body = source.slice(source.indexOf('async function effectLatency('), source.indexOf('// --- main')) + '\nawait effectLatency({}, () => {}, () => {}, 1)';
    else body = source.slice(source.indexOf('export class Forward'), source.indexOf('export class Api')).replace('export class Forward', 'class Forward') + '\nawait new Forward(12345).start()';
    let spawns = 0; f.calls.length = 0;
    await assert.rejects(runInNewContext('(async () => { ' + body + ' })()', { ownership: owner, NS: { fx: namespace, cp: namespace }, DP: namespace, spawn: () => { spawns++; } }), /N2.*refused/);
    assert.equal(spawns, 0);
    assert.equal(mutations(f.calls).length, 0);
  });
}

test('cleanup keeps the last alias of a borrowed digest-only image so Docker cannot delete the source image', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  const source = 'borrowed@sha256:' + 'a'.repeat(64), tag = 'borrowed:' + f.env.LAB_RUN_ID;
  f.images.set(source, { Id: 'borrowed-id', RepoTags: [], RepoDigests: [source], Config: {} });
  await owner.image(['tag', source, tag]); f.calls.length = 0;
  await owner.image(['clean']);
  assert.ok(f.images.has(source)); assert.ok(f.images.has(tag));
  assert.equal(mutations(f.calls).length, 0);
});
