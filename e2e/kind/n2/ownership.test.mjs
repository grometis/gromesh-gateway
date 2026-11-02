import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { runInNewContext } from 'node:vm';
import * as guard from '../../../scripts/kind-stack-guard.mjs';

const label = 'com.grometis.gromesh.n2-run';
const lab = 'com.grometis.gromesh.lab';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'n2-ownership-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { LAB_KUBECONFIG: join(dir, 'config'), LAB_RUN_ID: 'run-123456789abc', HOME: join(dir, 'home'), LAB_EVIDENCE_DIR: join(dir, 'evidence') };
  const calls = [], objects = new Map(), containers = new Map(), images = new Map(), volumes = new Map();
  let failOn = null, helmManifest = [];
  let created = false, ca = 'Y2E=', uid = 'system-original', context = 'kind-gromesh-n2-bafd0b463f146039e73843bd', nodeUID = 'k8s-node-original';
  const node = { Name: '/gromesh-n2-bafd0b463f146039e73843bd-control-plane', Id: 'node-original', Config: { Hostname: 'gromesh-n2-bafd0b463f146039e73843bd-control-plane', Labels: { 'io.x-k8s.kind.cluster': 'gromesh-n2-bafd0b463f146039e73843bd' } }, State: { Running: true }, Mounts: [], NetworkSettings: { Ports: { '6443/tcp': [{ HostPort: '12345', HostIp: '127.0.0.1' }] } } };
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
        if (args.includes('--filter') && filter.startsWith('label=io.x-k8s.kind.cluster=')) live = live.filter(c => c.Config.Labels['io.x-k8s.kind.cluster'] === 'gromesh-n2-bafd0b463f146039e73843bd');
        if (args.includes('--filter') && filter.startsWith('name=')) live = live.filter(c => c.Name === filter.slice('name=^'.length, -1));
        stdout = live.map(c => c.Id).join('\n');
      } else if (args[0] === 'inspect') stdout = JSON.stringify(args.slice(1).map(id => [node, ...containers.values()].find(c => c.Id === id || c.Name === '/' + id)));
      else if (args[0] === 'exec') {
        const at = args.indexOf('crictl');
        if (at < 0) stdout = args[2] === 'cat' && args[3]?.endsWith('/comm') ? 'gromesh-agent' : '';
        else if (args[at + 1] === 'inspect') {
          const id = args.at(-1);
          const pod = [...objects.values()].find(o => o.kind === 'Pod' && [...(o.status?.containerStatuses ?? []), ...(o.status?.initContainerStatuses ?? [])].some(c => c.containerID === 'containerd://' + id));
          const status = [...(pod?.status?.containerStatuses ?? []), ...(pod?.status?.initContainerStatuses ?? [])].find(c => c.containerID === 'containerd://' + id);
          stdout = JSON.stringify({ info: { pid: 123 }, status: { id, metadata: { name: status?.name }, labels: { 'io.kubernetes.pod.uid': pod?.metadata.uid, 'io.kubernetes.pod.namespace': pod?.metadata.namespace, 'io.kubernetes.pod.name': pod?.metadata.name } } });
        } else if (args[at + 1] === 'exec') stdout = 'owned output';
        else throw Error('unexpected CRI operation');
      }
      else if (args[0] === 'volume') stdout = args[1] === 'ls' ? [...volumes.keys()].join('\n') : JSON.stringify([volumes.get(args[2])]);
      else if (args[0] === 'image') {
        if (args[1] === 'ls') stdout = [...images.keys()].join('\n');
        else if (args[1] === 'inspect') stdout = JSON.stringify([images.get(args[2]) ?? { Id: 'source', Config: {} }]);
        else if (args[1] === 'rm') { for (const [tag, image] of images) if (image.Id === args[2]) images.delete(tag); }
        else throw Error('unexpected image call');
      } else if (args[0] === 'pull') stdout = '';
      else if (args[0] === 'tag') images.set(args[2], structuredClone(images.get(args[1]) ?? [...images.values()].find(i => i.Id === args[1]) ?? { Id: 'source', Config: {} }));
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
      else if (args[0] === 'get' && args[1] === 'clusters') stdout = created ? 'gromesh-n2-bafd0b463f146039e73843bd' : '';
      else if (args[0] === 'get' && args[1] === 'kubeconfig') stdout = 'kind config';
      else if (args[0] === 'delete') created = false;
      else throw Error('unexpected kind call');
    } else if (cmd === 'kubectl') {
      const a = args.slice(args.indexOf('--context') + 2);
      if (a[0] === 'config') stdout = JSON.stringify({ 'current-context': context, contexts: [{ name: context, context: { cluster: context, user: context } }], users: [{ name: context, user: { 'client-certificate-data': 'fixture-cert', 'client-key-data': 'fixture-key' } }], clusters: [{ name: context, cluster: { server: 'https://127.0.0.1:12345', 'certificate-authority-data': ca } }] });
      else if (a[0] === 'get') {
        const type = ({ namespaces: 'namespace', 'ciliumclusterwidenetworkpolicies.cilium.io': 'ciliumclusterwidenetworkpolicy', 'clusterroles.rbac.authorization.k8s.io': 'clusterrole' })[a[1]] ?? a[1], name = a[2]?.startsWith('-') ? undefined : a[2];
        if (type === 'namespace' && name === 'kube-system') stdout = JSON.stringify({ kind: 'Namespace', metadata: metadata('kube-system', uid) });
        else if (type === 'namespace' && !name) stdout = JSON.stringify({ items: [{ kind: 'Namespace', metadata: metadata('kube-system', uid) }, ...[...objects.values()].filter(o => o.kind === 'Namespace')] });
        else if (type === 'node' || type === 'nodes') stdout = JSON.stringify(name ? { apiVersion: 'v1', kind: 'Node', spec: { providerID: 'kind://docker/gromesh-n2-bafd0b463f146039e73843bd/gromesh-n2-bafd0b463f146039e73843bd-control-plane' }, metadata: { name: 'gromesh-n2-bafd0b463f146039e73843bd-control-plane', uid: nodeUID, labels: { 'kubernetes.io/hostname': 'gromesh-n2-bafd0b463f146039e73843bd-control-plane' } } } : { items: [{ apiVersion: 'v1', kind: 'Node', spec: { providerID: 'kind://docker/gromesh-n2-bafd0b463f146039e73843bd/gromesh-n2-bafd0b463f146039e73843bd-control-plane' }, metadata: { name: 'gromesh-n2-bafd0b463f146039e73843bd-control-plane', uid: nodeUID, labels: { 'kubernetes.io/hostname': 'gromesh-n2-bafd0b463f146039e73843bd-control-plane' } } }] });
        else if (type === 'pvc') stdout = JSON.stringify({ items: [...objects.values()].filter(o => o.kind === 'PersistentVolumeClaim') });
        else if (name && (type === 'configmap' || type === 'deployment')) stdout = JSON.stringify(objects.get(`${type}/${name}`) ?? (name === 'coredns' ? { kind: type, metadata: metadata(name) } : null));
        else stdout = JSON.stringify(name ? objects.get(`${type.toLowerCase()}/${name}`) ?? null : { items: [...objects.values()].filter(o => o.kind.toLowerCase() === type.toLowerCase()) });
      } else if (a[0] === 'api-resources') stdout = a.includes('--namespaced=true') ? 'pod\ndeployment\nreplicaset\ndaemonset\nstatefulset\njob\ncronjob\npersistentvolumeclaim\nservice\nconfigmap\nsecret\nlease\nserviceaccount\nrole\nrolebinding' : 'namespaces\nnodes\nciliumnode\nciliumclusterwidenetworkpolicies.cilium.io\nclusterroles.rbac.authorization.k8s.io\nclusterrolebinding\npersistentvolume\ncustomresourcedefinition\nmutatingwebhookconfiguration\nvalidatingwebhookconfiguration';
      else if (a.includes('--dry-run=client')) {
        const parsed = JSON.parse(options.input);
        for (const o of parsed.kind === 'List' ? parsed.items : [parsed]) {
          if (!['Namespace', 'ClusterRole', 'ClusterRoleBinding', 'CustomResourceDefinition', 'CiliumClusterwideNetworkPolicy'].includes(o.kind))
            o.metadata.namespace ??= a[a.indexOf('-n') + 1] && a.includes('-n') ? a[a.indexOf('-n') + 1] : 'default';
        }
        stdout = JSON.stringify(parsed);
      }
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
      } else if (a[0] === 'label' && a[1] === 'secret') {
        const o = objects.get('secret/' + a[2]);
        for (const pair of a.filter(v => v.startsWith('com.grometis.'))) { const at = pair.indexOf('='); o.metadata.labels[pair.slice(0, at)] = pair.slice(at + 1); }
      } else if (!['label', 'annotate', 'patch', 'wait', 'rollout'].includes(a[0])) throw Error('unexpected kubectl call ' + a.join(' '));
    } else if (cmd === 'helm') {
      stdout = JSON.stringify({ apiVersion: 'v1', kind: 'List', items: helmManifest });
      const verb = args.findIndex(a => ['install', 'upgrade'].includes(a));
      if (verb >= 0 && !args.includes('template')) {
        const release = args.slice(verb + 1).find(a => !a.startsWith('-')), namespace = args[args.indexOf('-n') + 1];
        const version = Math.max(0, ...[...objects.values()].filter(o => o.kind === 'Secret' && o.metadata.labels?.owner === 'helm' && o.metadata.labels?.name === release).map(o => Number(o.metadata.labels.version))) + 1;
        const chart = structuredClone(helmManifest).filter(o => !o.metadata.annotations?.['helm.sh/hook'] && o.kind !== 'CustomResourceDefinition');
        for (const o of chart) o.metadata.annotations = { ...o.metadata.annotations, 'meta.helm.sh/release-name': release, 'meta.helm.sh/release-namespace': namespace };
        const renderer = new guard.N2Lab({ env: { ...env, ...options.env }, execute });
        const rendered = await renderer.helmObjects(JSON.stringify({ apiVersion: 'v1', kind: 'List', items: chart }), namespace);
        const manifest = JSON.stringify({ apiVersion: 'v1', kind: 'List', items: rendered });
        for (const o of rendered) { o.metadata.uid ??= 'created-' + o.metadata.name; objects.set(`${o.kind.toLowerCase()}/${o.metadata.name}`, o); }
        const name = `sh.helm.release.v1.${release}.v${version}`;
        const payload = { name: release, namespace, version, info: { status: 'deployed' }, manifest };
        const data = Buffer.from(gzipSync(JSON.stringify(payload)).toString('base64')).toString('base64');
        objects.set('secret/' + name, { apiVersion: 'v1', kind: 'Secret', type: 'helm.sh/release.v1', metadata: { name, namespace, uid: 'created-' + name, resourceVersion: '7', labels: { owner: 'helm', name: release, version: String(version), status: 'deployed' } }, data: { release: data } });
      }
    }
    else throw Error('unexpected executable ' + cmd);
    if (cmd === 'kubectl' && args.includes('get') && args.includes('-l')) {
      const list = JSON.parse(stdout);
      if (list?.items) { const pairs = args[args.indexOf('-l') + 1].split(',').map(p => p.split('=')); list.items = list.items.filter(o => pairs.every(([k, v]) => o.metadata.labels?.[k] === v)); stdout = JSON.stringify(list); }
    }
    return { code: 0, stdout, stderr: '' };
  };
  const owner = () => new guard.N2Lab({ env, execute });
  return { env, calls, objects, containers, images, volumes, node, metadata, owner, dir, execute, fail: fn => { failOn = fn; }, helm: objects => { helmManifest = objects; }, setCA: v => { ca = v; }, setUID: v => { uid = v; }, setNodeUID: v => { nodeUID = v; }, setContext: v => { context = v; } };
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
  for (const bad of ['global', 'list']) {
    const f = fixture(t);
    const config = bad === 'global' ? join(f.env.HOME, '.kube/config') : join(f.dir, 'config:other');
    const o = new guard.N2Lab({ env: { ...f.env, LAB_KUBECONFIG: config }, execute: async () => { throw Error('must not execute'); } });
    await assert.rejects(o.createCluster('fixture'), /N2.*refused/);
  }
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  f.calls.length = 0;
  await assert.rejects(new guard.N2Lab({ env: { ...f.env, LAB_RUN_ID: 'other-123456789' }, execute: async () => { throw Error('must not execute'); } }).assertIdentity(), /N2.*refused/);
});
test('owned namespace and cluster remain intact when cascade effects cannot be conditioned', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  await owner.kubectl(['apply', '-f', '-'], { input: JSON.stringify(ns('gromesh-dp')) });
  assert.equal(f.objects.get('namespace/gromesh-dp').metadata.labels[label], f.env.LAB_RUN_ID);
  f.calls.length = 0;
  await assert.rejects(owner.kubectl(['delete', 'namespace', 'gromesh-dp']), /refused/);
  await assert.rejects(owner.destroyCluster(), /refused/);
  assert.equal(mutations(f.calls).length, 0);
  assert.ok(!f.calls.some(c => c.cmd === 'kind' && c.args[0] === 'delete'));
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
  f.containers.set('gromesh-n2-bafd0b463f146039e73843bd-fx-backend', { Id: 'foreign', Name: '/gromesh-n2-bafd0b463f146039e73843bd-fx-backend', Config: { Labels: {} } });
  f.calls.length = 0;
  await assert.rejects(owner.docker(['rm', '-f', 'gromesh-n2-bafd0b463f146039e73843bd-fx-backend'], { allowFail: true }), /N2.*refused/);
  assert.equal(mutations(f.calls).length, 0);
});
test('own fixture container is labelled, recorded and removed by ID', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  const name = 'gromesh-n2-bafd0b463f146039e73843bd-fx-backend';
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
test('image cleanup removes built IDs and retains borrowed aliases and the original source image', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  f.images.set('source', { Id: 'source', RepoTags: ['source'], Config: {} });
  await owner.image(['tag', 'source', 'lab:' + f.env.LAB_RUN_ID]);
  await owner.image(['build', '-t', 'built:' + f.env.LAB_RUN_ID, '.']);
  await owner.image(['clean']);
  assert.deepEqual([...f.images.keys()], ['source', 'lab:' + f.env.LAB_RUN_ID]);
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
    const config = { 'current-context': scenario === 'context' ? 'wrong' : 'kind-gromesh-n2-bafd0b463f146039e73843bd',
      contexts: [{ context: { cluster: 'kind-gromesh-n2-bafd0b463f146039e73843bd' } }],
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
else if (cmd === 'docker' && args[0] === 'rm') console.log('deleted own node ID');
else if (cmd === 'kind' && args[0] === 'get') console.log('kind fixture');
else if (cmd === 'kind' && args[0] === 'delete') console.log('deleted own fixture cluster');
else if (cmd === 'kubectl' && args.includes('api-resources')) console.log(args.includes('--namespaced=true') ? 'pod\npvc' : 'namespaces\nnodes\nclusterroles.rbac.authorization.k8s.io');
else if (cmd === 'kubectl' && args.includes('config')) json(f.config);
else if (cmd === 'kubectl' && args.includes('get')) {
  const a = args.slice(args.indexOf('get') + 1);
  if (a[0] === 'namespace') json(a[1] === 'kube-system' ? f.system : a[1] === 'gromesh-dp' ? f.namespaces.find(n => n.metadata.name === a[1]) : { items: f.namespaces });
  else if (a[0] === 'node' || a[0] === 'nodes') { const node = { apiVersion: 'v1', kind: 'Node', spec: { providerID: 'kind://docker/gromesh-n2-bafd0b463f146039e73843bd/gromesh-n2-bafd0b463f146039e73843bd-control-plane' }, metadata: { name: 'gromesh-n2-bafd0b463f146039e73843bd-control-plane', uid: 'k8s-node-original', labels: { 'kubernetes.io/hostname': 'gromesh-n2-bafd0b463f146039e73843bd-control-plane' } } }; json(a[0] === 'node' ? node : { items: [node] }); }
  else if (a[0] === 'pod') json({ items: [] });
  else if (a[0] === 'pvc') json({ items: f.pvcs });
  else if (a[0] === 'clusterroles.rbac.authorization.k8s.io') json({ items: [] });
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
    assert.equal(result.code, 1, result.stderr + '\n' + JSON.stringify(calls));
    assert.ok(calls.some(c => c.cmd === 'kubectl' && c.args.includes('config')), 'identity must reach fixture kubectl');
    assert.equal(mutations(calls).length, 0);
    assert.equal(readFileSync(results, 'utf8'), '{"evidence":"kept"}');
    assert.equal(readFileSync(owner.statePath, 'utf8'), proof);
    assert.ok(calls.every(c => ['docker', 'kind', 'kubectl'].includes(c.cmd)));
  });
}

test('an owned PVC is recorded but preserved with its namespace without an atomic cascade fence', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  await owner.kubectl(['apply', '-f', '-'], { input: JSON.stringify(ns('gromesh-dp')) });
  const pvc = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'own', namespace: 'gromesh-dp' }, spec: {} };
  await owner.kubectl(['create', '-f', '-'], { input: JSON.stringify(pvc) });
  f.calls.length = 0;
  await assert.rejects(owner.kubectl(['delete', 'namespace', 'gromesh-dp']), /refused/);
  assert.equal(mutations(f.calls).length, 0);
  assert.ok(f.objects.has('persistentvolumeclaim/own'));
});
test('Helm hook name collision refuses before a Job or release can be changed', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  await owner.kubectl(['apply', '-f', '-'], { input: JSON.stringify(ns('gromesh-dp')) });
  const hook = { apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'schema', namespace: 'gromesh-dp', annotations: { 'helm.sh/hook': 'pre-install,pre-upgrade' } }, spec: { selector: { matchLabels: { app: 'target' } }, template: { metadata: {}, spec: {} } } };
  f.helm([hook]);
  f.objects.set('job/schema', { ...hook, metadata: { ...hook.metadata, uid: 'foreign' } });
  f.calls.length = 0;
  await assert.rejects(owner.helm(['install', 'dp', 'chart', '-n', 'gromesh-dp']), /N2.*refused/);
  assert.equal(mutations(f.calls).length, 0);
});
test('Helm stamps pod templates and runs its schema Job with guarded UID cleanup', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  await owner.kubectl(['apply', '-f', '-'], { input: JSON.stringify(ns('gromesh-dp')) });
  const hook = { apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'schema', namespace: 'gromesh-dp', annotations: { 'helm.sh/hook': 'pre-install,pre-upgrade' } }, spec: { selector: { matchLabels: { app: 'target' } }, template: { metadata: {}, spec: {} } } };
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
  await assert.rejects(f.owner().assertIdentity(), /N2.*refused/);
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
    if (target === 'observer') body = 'class Client { ' + source.slice(source.indexOf('static async start('), source.indexOf('  constructor(label, args, target, child)')) + ' constructor() { spawn(); } }; await Client.start()';
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


test('foreign global policy refusal persists across guard processes and blocks cleanup even after it disappears', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  f.objects.set('ciliumclusterwidenetworkpolicy/n2c-deny-imds', { apiVersion: 'cilium.io/v2', kind: 'CiliumClusterwideNetworkPolicy', metadata: { name: 'n2c-deny-imds', uid: 'foreign' } });
  await assert.rejects(owner.preflightResources([{ type: 'ciliumclusterwidenetworkpolicy', name: 'n2c-deny-imds' }]), /refused/);
  assert.ok(existsSync(join(f.env.LAB_EVIDENCE_DIR, 'n2-refused.json')));
  f.objects.clear(); f.calls.length = 0;
  await assert.rejects(f.owner().preflightDestroyCluster(), /refused/);
  await assert.rejects(f.owner().destroyCluster(), /refused/);
  assert.equal(f.calls.length, 0);
});

test('cluster destruction discovers foreign cluster-scoped policies without a previous refusal', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  f.objects.set('clusterrole/foreign', { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'foreign', uid: 'foreign' } });
  f.calls.length = 0;
  await assert.rejects(owner.destroyCluster(), /refused/);
  assert.equal(mutations(f.calls).length, 0);
});

test('Helm and YAML conversion use the intended namespace instead of kubectl default', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  await owner.kubectl(['create', '-f', '-'], { input: JSON.stringify(ns('intended')) });
  const object = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'rendered' } };
  const converted = await owner.helmObjects(JSON.stringify(object), 'intended');
  assert.equal(converted[0].metadata.namespace, 'intended');
  const yamlOwner = new guard.N2Lab({ env: f.env, execute: (cmd, args, options) => f.execute(cmd, args,
    options?.input === 'yaml fixture' ? { ...options, input: JSON.stringify(object) } : options) });
  await yamlOwner.kubectl(['-n', 'intended', 'apply', '-f', '-'], { input: 'yaml fixture' });
  assert.equal(f.objects.get('configmap/rendered').metadata.namespace, 'intended');
});

test('fixture exec pins the recorded ID then stops when its name is replaced after inspection', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  const name = 'gromesh-n2-bafd0b463f146039e73843bd-fx-backend';
  await owner.docker(['run', '-d', '--name', name, 'fixture@sha256:' + 'a'.repeat(64), 'node']);
  const id = f.containers.get(name).Id;
  const racing = new guard.N2Lab({ env: f.env, execute: async (cmd, args, options) => {
    const result = await f.execute(cmd, args, options);
    if (cmd === 'docker' && args[0] === 'inspect' && args.length === 2 && args[1] === id) f.containers.set(name, { Id: 'foreign', Name: '/' + name, Config: { Labels: {} } });
    return result;
  } });
  f.calls.length = 0;
  await assert.rejects(racing.docker(['exec', name, 'true']), /refused/);
  assert.deepEqual(f.calls.findLast(c => c.cmd === 'docker' && c.args[0] === 'exec').args, ['exec', id, 'true']);
});

test('fixture set preflight refuses the second foreign fixture before replacing the first', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  const backend = 'gromesh-n2-bafd0b463f146039e73843bd-fx-backend';
  await owner.docker(['run', '-d', '--name', backend, 'fixture@sha256:' + 'a'.repeat(64), 'node']);
  f.containers.set('gromesh-n2-bafd0b463f146039e73843bd-fx-nodecidr', { Id: 'foreign', Name: '/gromesh-n2-bafd0b463f146039e73843bd-fx-nodecidr', Config: { Labels: {} } });
  const source = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function externalFixtures('), source.indexOf('\nfunction pod('));
  const ip = { v4: '192.0.2.1', v6: '2001:db8::1' }; f.calls.length = 0;
  await assert.rejects(runInNewContext(body + '\nexternalFixtures({ net: { backend: ip, nodeCidrTarget: ip, deniedTarget: ip, imdsHost: ip }, nodes: [] })', {
    ownership: owner, docker: (a, o) => owner.docker(a, o), cluster: 'gromesh-n2-bafd0b463f146039e73843bd', ip, IMDS: { v4: [], v6: [] },
    versions: { FIXTURE_IMAGE: 'fixture@sha256:' + 'a'.repeat(64) }, here: '/fixture', join,
  }), /refused/);
  assert.equal(mutations(f.calls).length, 0);
  assert.equal(f.containers.get(backend).Id, 'created-' + backend);
});

test('Cilium Helm refuses preexisting objects in kube-system without the same run receipt', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  const o = { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'cilium', namespace: 'kube-system' } };
  f.helm([o]);
  f.objects.set('serviceaccount/cilium', { ...o, metadata: { ...o.metadata, ...f.metadata('cilium', 'foreign') } });
  f.calls.length = 0;
  await assert.rejects(owner.helm(['upgrade', 'cilium', 'chart', '-n', 'kube-system', '--install']), /refused/);
  assert.equal(mutations(f.calls).length, 0);
  assert.ok(!f.calls.some(c => c.cmd === 'helm'), 'exclusive preflight must refuse foreign system resources before chart execution');
});

test('image cleanup targets an immutable ID and keeps borrowed aliases whose atomic removal is unavailable', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  const tag = 'built:' + f.env.LAB_RUN_ID;
  await owner.image(['build', '-t', tag, '.']);
  const original = f.images.get(tag).Id;
  let inspected = 0;
  const racing = new guard.N2Lab({ env: f.env, execute: async (cmd, args, options) => {
    const result = await f.execute(cmd, args, options);
    if (cmd === 'docker' && args[0] === 'image' && args[1] === 'inspect' && args[2] === tag && ++inspected === 2) { f.images.set(tag, { Id: 'foreign', Config: {} });
    }
    return result;
  } });
  await racing.image(['clean']);
  assert.equal(f.images.get(tag)?.Id, 'foreign');
  assert.deepEqual(f.calls.filter(c => c.cmd === 'docker' && c.args[0] === 'image' && c.args[1] === 'rm').map(c => c.args), [['image', 'rm', original]]);
});

for (const change of ['namespace', 'PVC', 'UID', 'CA']) {
  test(`cluster deletion repeats inventory and identity proof at the action boundary: ${change}`, async t => {
    const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
    let armed = true;
    const racing = new guard.N2Lab({ env: f.env, execute: async (cmd, args, options) => {
      const result = await f.execute(cmd, args, options);
      if (armed && cmd === 'kubectl' && args.includes('get') && args.includes('pvc')) {
        armed = false;
        if (change === 'namespace') f.objects.set('namespace/late', { ...ns('late'), metadata: { name: 'late', uid: 'foreign' } });
        if (change === 'PVC') f.objects.set('persistentvolumeclaim/late', { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'late', namespace: 'kube-system', uid: 'foreign' } });
        if (change === 'UID') f.setUID('foreign');
        if (change === 'CA') f.setCA('Zm9yZWlnbg==');
      }
      return result;
    } });
    f.calls.length = 0;
    await assert.rejects(racing.destroyCluster(), /refused/);
    assert.equal(mutations(f.calls).length, 0);
  });
}

test('Cilium install and resumed upgrade stamp and record both namespaced and global objects', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  const manifests = [
    { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'cilium' } },
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'cilium-role' } },
  ];
  f.helm(manifests);
  const installer = f.owner();
  await installer.helm(['upgrade', 'cilium', 'chart', '-n', 'kube-system', '--install']);
  const receipt = JSON.parse(readFileSync(owner.statePath, 'utf8'));
  assert.equal(receipt.resources['serviceaccount/kube-system/cilium'], 'created-cilium');
  assert.equal(receipt.resources['clusterrole//cilium-role'], 'created-cilium-role');
  assert.equal(f.objects.get('clusterrole/cilium-role').metadata.namespace, undefined);
  assert.equal(f.objects.get('serviceaccount/cilium').metadata.labels[label], f.env.LAB_RUN_ID);
  await installer.helm(['upgrade', 'cilium', 'chart', '-n', 'kube-system', '--install']);
  f.objects.get('clusterrole/cilium-role').metadata.uid = 'replacement'; f.calls.length = 0;
  await assert.rejects(installer.helm(['upgrade', 'cilium', 'chart', '-n', 'kube-system', '--install']), /refused/);
  assert.equal(mutations(f.calls).length, 0);
});

test('a namespace delete rechecks PVC inventory after the final identity check and uses a UID precondition', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  await owner.kubectl(['create', '-f', '-'], { input: JSON.stringify(ns('own')) });
  let pvcChecks = 0;
  const racing = new guard.N2Lab({ env: f.env, execute: async (cmd, args, options) => {
    const result = await f.execute(cmd, args, options);
    if (cmd === 'kubectl' && args.includes('pvc') && ++pvcChecks === 1)
      f.objects.set('persistentvolumeclaim/late', { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'late', namespace: 'own', uid: 'foreign' } });
    return result;
  } });
  f.calls.length = 0;
  await assert.rejects(racing.kubectl(['delete', 'namespace', 'own']), /refused/);
  assert.equal(mutations(f.calls).length, 0);
});

for (const entrypoint of ['down', 'run-all cleanup']) {
  test(`${entrypoint} in a fresh process preserves evidence and cluster after a global policy refusal`, async t => {
    const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
    f.objects.set('ciliumclusterwidenetworkpolicy/n2c-deny-imds', { apiVersion: 'cilium.io/v2', kind: 'CiliumClusterwideNetworkPolicy', metadata: { name: 'n2c-deny-imds', uid: 'foreign' } });
    await assert.rejects(owner.preflightResources([{ type: 'ciliumclusterwidenetworkpolicy', name: 'n2c-deny-imds' }]));
    const record = join(f.dir, 'unexpected');
    const bin = join(f.dir, 'bin'); mkdirSync(bin);
    for (const cmd of ['docker', 'kind', 'kubectl', 'git', 'helm']) {
      const file = join(bin, cmd);
      writeFileSync(file, `#!/bin/bash\nprintf '%s\\n' '${cmd}' >> '${record}'\nexit 99\n`); chmodSync(file, 0o755);
    }
    const evidence = join(f.env.LAB_EVIDENCE_DIR, 'results.json'); writeFileSync(evidence, 'retained evidence');
    let command;
    if (entrypoint === 'down') command = ['bash', [new URL('./cluster.sh', import.meta.url).pathname, 'down']];
    else {
      const source = readFileSync(new URL('./external/run-all.sh', import.meta.url), 'utf8');
      const cleanup = source.slice(source.indexOf('cleanup() {'), source.indexOf('\ntrap cleanup EXIT'));
      command = ['bash', ['-c', `set -euo pipefail
        guard="$1"; n2="$2"; owned=1; creating=0; failed=0; work="$3"; sampler_pid=""; trees=()
        stop_sampler() { :; }
        ${cleanup}
        cleanup`, 'test', new URL('../../../scripts/kind-stack-guard.mjs', import.meta.url).pathname, new URL('.', import.meta.url).pathname, f.dir]];
    }
    assert.throws(() => execFileSync(...command, { env: { ...process.env, ...f.env, PATH: bin + ':' + process.env.PATH }, stdio: 'pipe' }), e => e.status === 1);
    assert.equal(existsSync(record), false, 'refusal must precede every external executable');
    assert.equal(readFileSync(evidence, 'utf8'), 'retained evidence');
    assert.ok(existsSync(owner.statePath));
  });
}

test('cluster.sh routes both Cilium install and upgrade through the central resource guard', t => {
  const f = fixture(t), bin = join(f.dir, 'bin'); mkdirSync(bin);
  const record = join(f.dir, 'calls');
  for (const cmd of ['node', 'helm']) {
    const file = join(bin, cmd);
    writeFileSync(file, `#!/bin/bash\nprintf '%s ' '${cmd}' >> '${record}'\nprintf '%s ' "$@" >> '${record}'\nprintf '\\n' >> '${record}'\n`); chmodSync(file, 0o755);
  }
  const source = readFileSync(new URL('./cluster.sh', import.meta.url), 'utf8');
  const h = source.slice(source.indexOf('h() {'), source.indexOf('\nk() {'));
  execFileSync('bash', ['-c', `guard=central-guard; context=fixture; ${h}\nh install cilium chart -n kube-system\nh upgrade cilium chart --install -n kube-system`], { env: { ...process.env, ...f.env, PATH: bin + ':' + process.env.PATH } });
  const calls = readFileSync(record, 'utf8').trim().split('\n');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.startsWith('node central-guard n2-helm ')));
});

test('image load validates the exported digest and imports only into the recorded node IDs', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  const tag = 'lab:' + f.env.LAB_RUN_ID, id = 'sha256:' + 'c'.repeat(64);
  f.images.set('source', { Id: id, Config: {} });
  await owner.image(['tag', 'source', tag]);
  const execute = async (cmd, args, options) => {
    if (cmd === 'kind' && args[0] === 'load') { f.calls.push({ cmd, args }); return { code: 0, stdout: '', stderr: '' }; }
    if (cmd === 'docker' && args[0] === 'image' && args[1] === 'save') {
      f.calls.push({ cmd, args }); writeFileSync(args[args.indexOf('--output') + 1], 'validated archive');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'tar') return { code: 0, stdout: JSON.stringify([{ Config: 'blobs/sha256/' + 'c'.repeat(64), RepoTags: [tag] }]), stderr: '' };
    if (cmd === 'docker' && args[0] === 'exec') { f.calls.push({ cmd, args, input: options.input }); return { code: 0, stdout: '', stderr: '' }; }
    return f.execute(cmd, args, options);
  };
  const loader = new guard.N2Lab({ env: f.env, execute }); f.calls.length = 0;
  await loader.loadImage(tag);
  const imports = f.calls.filter(c => c.cmd === 'docker' && c.args.includes('import'));
  assert.equal(imports.length, 1);
  assert.equal(imports[0].args[2], 'node-original');
  assert.equal(imports[0].input.toString(), 'validated archive');
  assert.ok(!f.calls.some(c => c.cmd === 'kind' && c.args[0] === 'load'));
});

test('kubectl mutation rechecks the target UID at the action boundary', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  await owner.kubectl(['create', '-f', '-'], { input: JSON.stringify(ns('own')) });
  const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'probe', namespace: 'own' } };
  await owner.kubectl(['create', '-f', '-'], { input: JSON.stringify(pod) });
  let inspections = 0;
  const racing = new guard.N2Lab({ env: f.env, execute: async (cmd, args, options) => {
    if (cmd === 'kubectl' && args.includes('exec')) { f.calls.push({ cmd, args }); return { code: 0, stdout: '', stderr: '' }; }
    const result = await f.execute(cmd, args, options);
    if (cmd === 'kubectl' && args.includes('get') && args.includes('pod') && args.includes('probe') && ++inspections === 1)
      f.objects.get('pod/probe').metadata.uid = 'foreign';
    if (cmd === 'kubectl' && args.includes('exec')) return { code: 0, stdout: '', stderr: '' };
    return result;
  } });
  // The fake must model exec without reaching an external process.
  f.calls.length = 0;
  await assert.rejects(racing.kubectl(['exec', '-n', 'own', 'probe', '--', 'true']), /refused/);
  assert.ok(!f.calls.some(c => c.cmd === 'kubectl' && c.args.includes('exec')));
});

test('refusal evidence is written in the current suite directory as well as the creation run directory', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  const suiteDir = join(f.dir, 'suite-evidence');
  const suite = new guard.N2Lab({ env: { ...f.env, LAB_EVIDENCE_DIR: suiteDir }, execute: f.execute });
  await assert.rejects(suite.preflightResources([{ type: 'pod', name: 'missing', namespace: 'own' }], true), /refused/);
  assert.ok(existsSync(join(suiteDir, 'n2-refused.json')));
  assert.ok(existsSync(join(f.env.LAB_EVIDENCE_DIR, 'n2-refused.json')));
});

test('rollout restart carries the proved resource UID and version into the write', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  await owner.kubectl(['create', '-f', '-'], { input: JSON.stringify(ns('own')) });
  const deployment = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'app', namespace: 'own', resourceVersion: '17' }, spec: { selector: { matchLabels: { app: 'target' } }, template: { metadata: {}, spec: {} } } };
  await owner.kubectl(['create', '-f', '-'], { input: JSON.stringify(deployment) });
  const racer = new guard.N2Lab({ env: f.env, execute: async (cmd, args, options) => {
    if (cmd === 'kubectl' && args.includes('restart')) { f.calls.push({ cmd, args }); return { code: 0, stdout: '', stderr: '' }; }
    return f.execute(cmd, args, options);
  } });
  f.calls.length = 0;
  await racer.kubectl(['-n', 'own', 'rollout', 'restart', 'deployment/app']);
  const write = f.calls.find(c => c.input && !c.args.includes('--dry-run=client'));
  assert.ok(write, 'restart must use a conditional object write');
  const object = JSON.parse(write.input);
  assert.equal(object.metadata.uid, 'created-app');
  assert.equal(object.metadata.resourceVersion, '17');
  assert.ok(object.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt']);
});

test('refusing a global kubeconfig preserves its directory and records only run evidence', async t => {
  const f = fixture(t), global = join(f.env.HOME, '.kube/config');
  mkdirSync(join(f.env.HOME, '.kube'), { recursive: true }); writeFileSync(global, 'user config');
  const owner = new guard.N2Lab({ env: { ...f.env, LAB_KUBECONFIG: global }, execute: f.execute });
  await assert.rejects(owner.createCluster('fixture'), /refused/);
  assert.equal(existsSync(global + '.n2-owner.json.refused'), false);
  assert.equal(readFileSync(global, 'utf8'), 'user config');
  assert.ok(existsSync(join(f.env.LAB_EVIDENCE_DIR, 'n2-refused.json')));
});

async function ownedPod(f, owner, configure = p => p) {
  await owner.kubectl(['create', '-f', '-'], { input: JSON.stringify(ns('own')) });
  await owner.kubectl(['create', '-f', '-'], { input: JSON.stringify(configure({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'target', namespace: 'own' },
    spec: { nodeName: 'gromesh-n2-bafd0b463f146039e73843bd-control-plane', containers: [{ name: 'app' }] },
    status: { containerStatuses: [{ name: 'app', containerID: 'containerd://' + 'a'.repeat(64) }] } })) });
  return f.objects.get('pod/target');
}
const execMutations = calls => calls.filter(c => c.cmd === 'kubectl' && c.args.includes('exec') || c.cmd === 'docker' && c.args[0] === 'exec' && !c.args.includes('inspect'));

for (const change of ['pod UID', 'container ID', 'namespace UID', 'node UID', 'node cluster']) {
  test(`container capability rejects replaced ${change} before exec or signal`, async t => {
    const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
    const p = await ownedPod(f, owner);
    const target = await owner.containerTarget('own', 'target', 'app');
    if (change === 'pod UID') p.metadata.uid = 'replacement';
    if (change === 'container ID') p.status.containerStatuses[0].containerID = 'containerd://' + 'b'.repeat(64);
    if (change === 'namespace UID') f.objects.get('namespace/own').metadata.uid = 'replacement';
    if (change === 'node cluster') f.node.Config.Labels['io.x-k8s.kind.cluster'] = 'foreign';
    if (change === 'node UID') f.setNodeUID('replacement');
    f.calls.length = 0;
    await assert.rejects(owner.execContainer(target, ['kill', '-STOP', '1']), /refused/);
    assert.equal(execMutations(f.calls).length, 0);
  });
}

test('exec uses CRI ID on Docker node ID, then discards output on a post-exec replacement', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  const p = await ownedPod(f, owner);
  const result = await owner.kubectl(['exec', '-n', 'own', 'target', '-c', 'app', '--', 'true']);
  assert.equal(result.stdout, 'owned output');
  const call = f.calls.findLast(c => c.cmd === 'docker' && c.args.includes('crictl') && c.args.includes('exec'));
  assert.deepEqual(call.args, ['exec', 'node-original', 'crictl', 'exec', 'a'.repeat(64), 'true']);
  assert.ok(!f.calls.some(c => c.cmd === 'kubectl' && c.args.includes('exec')));
  const racing = new guard.N2Lab({ env: f.env, execute: async (cmd, args, opts) => {
    const result = await f.execute(cmd, args, opts);
    if (cmd === 'docker' && args.includes('crictl') && args.includes('exec')) p.metadata.uid = 'replacement';
    return result;
  } });
  await assert.rejects(racing.kubectl(['exec', '-n', 'own', 'target', '--', 'true']), /refused/);
});

test('unbound node commands and kubectl deployment exec never fall back to names', async t => {
  for (const command of ['node', 'deployment']) {
    const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture'); await ownedPod(f, owner); f.calls.length = 0;
    await assert.rejects(command === 'node' ? owner.docker(['exec', f.node.Name.slice(1), 'kill', '-STOP', '123']) : owner.kubectl(['exec', '-n', 'own', 'deploy/unknown', '--', 'true']), /refused/);
    assert.equal(execMutations(f.calls).length, 0);
  }
});

for (const kind of ['Pod', 'Deployment', 'ReplicaSet', 'DaemonSet', 'StatefulSet', 'Job', 'CronJob', 'PersistentVolumeClaim', 'Service', 'ConfigMap', 'Secret']) {
  test(`cascade inventories foreign ${kind} in an existing namespace before any deletion`, async t => {
    const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
    f.objects.set(`${kind.toLowerCase()}/foreign`, { apiVersion: 'v1', kind, metadata: { name: 'foreign', namespace: 'kube-system', uid: 'foreign' } }); f.calls.length = 0;
    await assert.rejects(owner.destroyCluster(), /refused/);
    assert.equal(mutations(f.calls).length, 0);
  });
}

for (const unexpected of ['owner', 'finalizer', 'dependent']) {
  test(`receipt cannot authorize unexpected ${unexpected} deletion effects`, async t => {
    const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture'); const p = await ownedPod(f, owner);
    if (unexpected === 'owner') p.metadata.ownerReferences = [{ apiVersion: 'apps/v1', kind: 'Deployment', name: 'foreign', uid: 'foreign', controller: true }];
    if (unexpected === 'finalizer') p.metadata.finalizers = ['foreign.example/delete'];
    if (unexpected === 'dependent') f.objects.set('secret/dependent', { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'dependent', namespace: 'own', uid: 'foreign', ownerReferences: [{ apiVersion: 'v1', kind: 'Pod', name: 'target', uid: p.metadata.uid }] } });
    f.calls.length = 0; await assert.rejects(owner.kubectl(['delete', 'pod', 'target', '-n', 'own']), /refused/);
    assert.equal(mutations(f.calls).length, 0);
  });
}

test('controller CiliumNode requires the recorded Kubernetes Node UID, never its name alone', async t => {
  for (const valid of [true, false]) {
    const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
    f.objects.set('ciliumnode/gromesh-n2-bafd0b463f146039e73843bd-control-plane', { apiVersion: 'cilium.io/v2', kind: 'CiliumNode', metadata: { name: 'gromesh-n2-bafd0b463f146039e73843bd-control-plane', uid: 'cilium-created', ownerReferences: [{ apiVersion: 'v1', kind: 'Node', name: 'gromesh-n2-bafd0b463f146039e73843bd-control-plane', uid: valid ? 'k8s-node-original' : 'foreign', controller: true }] } });
    f.calls.length = 0;
    if (valid) await owner.preflightDestroyCluster();
    else await assert.rejects(owner.preflightDestroyCluster(), /refused/);
    assert.equal(mutations(f.calls).length, 0);
  }
});

test('destruction preserves volumes with evidence because Docker has no conditional volume removal', async t => {
  const f = fixture(t);
  const execute = async (cmd, args, opts) => {
    const result = await f.execute(cmd, args, opts);
    if (cmd === 'kind' && args[0] === 'create') {
      f.volumes.set('own', { Name: 'own', CreatedAt: 'original' });
      f.node.Mounts.push({ Type: 'volume', Name: 'own', Source: '/docker/own', Destination: '/var' });
    }
    return result;
  };
  const owner = new guard.N2Lab({ env: f.env, execute }); await owner.createCluster('fixture'); f.calls.length = 0;
  await assert.rejects(owner.destroyCluster(), /refused/);
  assert.ok(!f.calls.some(c => c.cmd === 'docker' && c.args[0] === 'volume' && c.args[1] === 'rm'));
  assert.equal(JSON.parse(readFileSync(join(f.env.LAB_EVIDENCE_DIR, 'n2-preserved.json'))).strategy, 'preserve-instead-of-delete');
  assert.ok(f.volumes.has('own'));
});

test('STOP and CONT are sent through the runtime by immutable task ID, never a host PID', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture'); await ownedPod(f, owner);
  const target = await owner.containerTarget('own', 'target', 'app'); f.calls.length = 0;
  await owner.signalContainer(target, 'STOP', 'gromesh-agent');
  await owner.signalContainer(target, 'CONT', 'gromesh-agent');
  const signals = f.calls.filter(c => c.cmd === 'docker' && c.args.includes('tasks'));
  assert.deepEqual(signals.map(c => c.args), ['SIGSTOP', 'SIGCONT'].map(signal => ['exec', 'node-original', 'ctr', '--namespace=k8s.io', 'tasks', 'kill', '--signal', signal, 'a'.repeat(64)]));
  assert.ok(!f.calls.some(c => c.cmd === 'docker' && c.args[2] === 'kill'));
});

for (const kind of ['UID', 'containerID', 'namespace', 'CA', 'node']) {
  test(`last CRI preflight catches a concurrent ${kind} replacement before a signal`, async t => {
    const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture'); const pod = await ownedPod(f, owner);
    const target = await owner.containerTarget('own', 'target', 'app'); let armed = true;
    const racing = new guard.N2Lab({ env: f.env, execute: async (cmd, args, options) => {
      const result = await f.execute(cmd, args, options);
      if (armed && cmd === 'docker' && args.includes('crictl') && args.includes('inspect')) {
        armed = false;
        if (kind === 'UID') pod.metadata.uid = 'foreign';
        if (kind === 'containerID') pod.status.containerStatuses[0].containerID = 'containerd://' + 'b'.repeat(64);
        if (kind === 'namespace') f.objects.get('namespace/own').metadata.uid = 'foreign';
        if (kind === 'CA') f.setCA('Zm9yZWlnbg==');
        if (kind === 'node') f.setNodeUID('foreign');
      }
      return result;
    } });
    f.calls.length = 0;
    await assert.rejects(racing.signalContainer(target, 'STOP', 'gromesh-agent'), /refused/);
    assert.equal(execMutations(f.calls).length, 0);
  });
}

test('CRI labels must match the complete pod identity before executing', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture'); await ownedPod(f, owner);
  const target = await owner.containerTarget('own', 'target', 'app');
  const racing = new guard.N2Lab({ env: f.env, execute: async (cmd, args, options) => {
    const result = await f.execute(cmd, args, options);
    if (cmd === 'docker' && args.includes('crictl') && args.includes('inspect')) {
      const info = JSON.parse(result.stdout); info.status.labels['io.kubernetes.pod.uid'] = 'foreign'; result.stdout = JSON.stringify(info);
    }
    return result;
  } });
  f.calls.length = 0;
  await assert.rejects(racing.execContainer(target, ['true']), /refused/);
  assert.equal(execMutations(f.calls).length, 0);
});

test('exec arguments cannot bypass proof by including a dry-run string in the remote command', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture'); await ownedPod(f, owner);
  f.objects.get('pod/target').metadata.uid = 'foreign'; f.calls.length = 0;
  await assert.rejects(owner.kubectl(['exec', '-n', 'own', 'target', '--', 'echo', '--dry-run=client']), /refused/);
  assert.equal(execMutations(f.calls).length, 0);
});

test('a replaced streaming target refuses before spawning any process', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture'); await ownedPod(f, owner);
  const target = await owner.containerTarget('own', 'target', 'app'); let spawns = 0;
  const guarded = new guard.N2Lab({ env: f.env, execute: f.execute, spawnProcess: () => { spawns++; throw Error('must not spawn'); } });
  f.objects.get('pod/target').status.containerStatuses[0].containerID = 'containerd://' + 'b'.repeat(64); f.calls.length = 0;
  await assert.rejects(guarded.spawnContainer(target, ['true']), /refused/);
  assert.equal(spawns, 0);
  assert.equal(execMutations(f.calls).length, 0);
});

test('stream verification rejects collected evidence after identity changes, using a fake child only', async t => {
  const { EventEmitter } = await import('node:events');
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture'); await ownedPod(f, owner);
  const target = await owner.containerTarget('own', 'target', 'app'); const child = new EventEmitter();
  const guarded = new guard.N2Lab({ env: f.env, execute: f.execute, spawnProcess: (cmd, args) => {
    assert.equal(cmd, 'docker');
    assert.deepEqual(args, ['exec', '-i', 'node-original', 'crictl', 'exec', '-i', 'a'.repeat(64), 'true']);
    return child;
  } });
  const stream = await guarded.spawnContainer(target, ['true']);
  f.objects.get('pod/target').metadata.uid = 'replacement';
  child.emit('close', 0);
  await assert.rejects(stream.verified, /refused/);
});

test('leaf deletion sets Orphan explicitly and binds both UID and resourceVersion', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture'); const pod = await ownedPod(f, owner);
  pod.metadata.resourceVersion = '17';
  await owner.kubectl(['delete', 'pod', '-n', 'own', 'target', '--wait=false']);
  const deletion = f.calls.findLast(c => c.cmd === 'kubectl' && c.args.includes('delete') && c.args.includes('--raw'));
  assert.deepEqual(JSON.parse(deletion.input), { apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: 'Orphan', preconditions: { uid: 'created-target', resourceVersion: '17' } });
});

test('new objects are never adopted as known system baseline solely by being in kube-system', async t => {
  const f = fixture(t);
  f.objects.set('pod/foreign', { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'foreign', namespace: 'kube-system', uid: 'foreign' } });
  const owner = f.owner(); await assert.rejects(owner.createCluster('fixture'), /refused/);
  assert.equal(JSON.parse(readFileSync(owner.statePath)).creation.exclusive, false);
  f.calls.length = 0;
  await assert.rejects(owner.preflightDestroyCluster(), /refused/);
  assert.equal(mutations(f.calls).length, 0);
});

test('Docker hostname and Kubernetes providerID must bind the recorded node, not merely match names', async t => {
  for (const change of ['hostname', 'providerID']) {
    const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture'); await ownedPod(f, owner);
    const target = await owner.containerTarget('own', 'target', 'app');
    const guarded = new guard.N2Lab({ env: f.env, execute: async (cmd, args, options) => {
      const result = await f.execute(cmd, args, options);
      if (change === 'providerID' && cmd === 'kubectl' && args.includes('node')) {
        const node = JSON.parse(result.stdout); node.spec.providerID = 'kind://docker/foreign/foreign'; result.stdout = JSON.stringify(node);
      }
      return result;
    } });
    if (change === 'hostname') f.node.Config.Hostname = 'foreign';
    f.calls.length = 0;
    await assert.rejects(guarded.execContainer(target, ['true']), /refused/);
    assert.equal(execMutations(f.calls).length, 0);
  }
});

test('creation baseline cannot adopt a foreign namespace, cluster role or PVC', async t => {
  for (const object of [
    { ...ns('foreign'), metadata: { name: 'foreign', uid: 'foreign' } },
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'foreign', uid: 'foreign' } },
    { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'foreign', namespace: 'kube-system', uid: 'foreign' } },
  ]) {
    const f = fixture(t); f.objects.set(`${object.kind.toLowerCase()}/foreign`, object);
    const owner = f.owner(); await assert.rejects(owner.createCluster('fixture'), /refused/); f.calls.length = 0;
    await assert.rejects(owner.preflightDestroyCluster(), /refused/);
    assert.equal(mutations(f.calls).length, 0);
  }
});

test('suite cleanup refuses the cascade before invoking its fixture mutation callback', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  await owner.kubectl(['create', '-f', '-'], { input: JSON.stringify(ns('own')) });
  const source = readFileSync(new URL('./components/lab.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export async function removeSuiteObjects')).replace('export async function', 'async function');
  let callbacks = 0; f.calls.length = 0;
  await assert.rejects(runInNewContext(body + '\nremoveSuiteObjects([], async () => callback())', {
    ownership: owner, NS: { dp: 'own', cp: 'absent' }, POLICIES: [], kubectl: a => owner.kubectl(a), callback: () => { callbacks++; },
  }), /refused/);
  assert.equal(callbacks, 0);
  assert.equal(mutations(f.calls).length, 0);
});

test('multi-object deletion refuses atomically instead of risking partial cleanup on a later identity change', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture'); await ownedPod(f, owner);
  await owner.kubectl(['create', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'second', namespace: 'own' } }) });
  f.calls.length = 0;
  await assert.rejects(owner.kubectl(['delete', 'pod', 'target', 'second', '-n', 'own']), /refused/);
  assert.equal(mutations(f.calls).length, 0);
  assert.ok(f.objects.has('pod/target')); assert.ok(f.objects.has('pod/second'));
});

// R6 review regressions use only the in-memory executors above.
test('mutation pins the proved kubeconfig even when the original is replaced at the write boundary', async t => {
  const f = fixture(t); await f.owner().createCluster('fixture');
  let writeConfig;
  const owner = new guard.N2Lab({ env: f.env, execute: async (cmd, args, options) => {
    if (cmd === 'kubectl' && args.includes('create') && !args.includes('--dry-run=client')) {
      writeFileSync(f.env.LAB_KUBECONFIG, 'foreign cluster');
      const path = args[args.indexOf('--kubeconfig') + 1];
      writeConfig = { path, bytes: readFileSync(path, 'utf8') };
      assert.equal(lstatSync(path).mode & 0o777, 0o600);
      assert.equal(lstatSync(dirname(path)).mode & 0o777, 0o700);
      assert.equal(options.env.KUBECONFIG, path);
    }
    return f.execute(cmd, args, options);
  } });
  await owner.kubectl(['create', '-f', '-'], { input: JSON.stringify(ns('own')) });
  assert.notEqual(writeConfig.path, f.env.LAB_KUBECONFIG);
  assert.notEqual(writeConfig.bytes, 'foreign cluster');
  await owner.assertIdentity(); // A proved execution never reopens the replaced source.
});

async function ownedDeployment(f, owner) {
  await owner.kubectl(['create', '-f', '-'], { input: JSON.stringify(ns('own')) });
  await owner.kubectl(['create', '-f', '-'], { input: JSON.stringify({ apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'app', namespace: 'own', resourceVersion: '17' },
    spec: { selector: { matchLabels: { app: 'target' } }, template: { metadata: { labels: { app: 'target' } }, spec: {} } } }) });
  return f.objects.get('deployment/app');
}
for (const operation of ['restart', 'upgrade']) for (const scenario of ['malicious pod', 'orphan pod', 'orphan replicaset']) {
  test(`${operation} refuses ${scenario} selected by its controller before mutation`, async t => {
    const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture'); const deployment = await ownedDeployment(f, owner);
    const ref = { apiVersion: 'apps/v1', kind: 'Deployment', name: 'app', uid: deployment.metadata.uid, controller: true };
    f.objects.set('replicaset/owned-rs', { apiVersion: 'apps/v1', kind: 'ReplicaSet', metadata: { ...f.metadata('owned-rs'), namespace: 'own', ownerReferences: [ref] }, spec: { selector: deployment.spec.selector } });
    const kind = scenario === 'orphan replicaset' ? 'ReplicaSet' : 'Pod';
    f.objects.set(`${kind.toLowerCase()}/foreign`, { apiVersion: kind === 'Pod' ? 'v1' : 'apps/v1', kind,
      metadata: { name: 'foreign', namespace: 'own', uid: 'foreign', labels: { app: 'target' },
        ...(scenario === 'malicious pod' ? { ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'owned-rs', uid: 'owned-rs', controller: true }] } : {}) }, spec: {} });
    f.helm([structuredClone(deployment)]); f.calls.length = 0;
    await assert.rejects(operation === 'restart' ? owner.kubectl(['-n', 'own', 'rollout', 'restart', 'deployment/app']) : owner.helm(['upgrade', 'dp', 'chart', '-n', 'own']), /refused/);
    assert.equal(mutations(f.calls).length, 0);
    assert.ok(f.objects.has(`${kind.toLowerCase()}/foreign`));
  });
}

test('post-upgrade refuses a foreign Helm-selector secret without labeling or adopting it', async t => {
  const f = fixture(t); await f.owner().createCluster('fixture');
  await f.owner().kubectl(['create', '-f', '-'], { input: JSON.stringify(ns('own')) });
  const owner = new guard.N2Lab({ env: f.env, execute: async (cmd, args, options) => {
    const result = await f.execute(cmd, args, options);
    if (cmd === 'helm' && args.includes('upgrade')) f.objects.set('secret/foreign', { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'foreign', namespace: 'own', uid: 'foreign-secret', resourceVersion: '23', labels: { owner: 'helm', name: 'dp' } } });
    return result;
  } });
  f.calls.length = 0;
  await assert.rejects(owner.helm(['upgrade', 'dp', 'chart', '-n', 'own']), /refused/);
  assert.ok(!f.calls.some(c => c.cmd === 'kubectl' && c.args.includes('label')));
  assert.equal(JSON.parse(readFileSync(owner.statePath)).resources['secret/own/foreign'], undefined);
  assert.ok(existsSync(join(f.env.LAB_EVIDENCE_DIR, 'n2-refused.json')));
});

test('named IMDS route operation validates addresses and binds both fixture and node IDs', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  await owner.docker(['run', '-d', '--name', 'gromesh-n2-bafd0b463f146039e73843bd-fx-imds', '--network', 'kind', 'fixture@sha256:' + 'a'.repeat(64), 'node']);
  f.containers.get('gromesh-n2-bafd0b463f146039e73843bd-fx-imds').NetworkSettings = { Networks: { kind: { IPAddress: '172.18.0.9', GlobalIPv6Address: 'fd00::9' } } };
  await owner.addRoute('gromesh-n2-bafd0b463f146039e73843bd-control-plane', '169.254.169.254', '172.18.0.9');
  assert.deepEqual(f.calls.findLast(c => c.cmd === 'docker' && c.args.includes('replace')).args,
    ['exec', 'node-original', 'ip', 'route', 'replace', '169.254.169.254/32', 'via', '172.18.0.9']);
  f.calls.length = 0;
  await assert.rejects(owner.addRoute('gromesh-n2-bafd0b463f146039e73843bd-control-plane', '1.2.3.4;kill', '172.18.0.9'), /refused/);
  assert.equal(execMutations(f.calls).length, 0);
});

test('named node clock uses only bracketed fixed reads on the proved node ID', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture'); f.calls.length = 0;
  await owner.nodeClock('gromesh-n2-bafd0b463f146039e73843bd-control-plane');
  assert.deepEqual(execMutations(f.calls).map(c => c.args), [
    ['exec', 'node-original', 'date', '+%s%3N'], ['exec', 'node-original', 'cat', '/proc/uptime'], ['exec', 'node-original', 'date', '+%s%3N'],
  ]);
});

test('pod volume capability rejects an unrelated runtime mount before reading or rewriting host files', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture'); const p = await ownedPod(f, owner, p => {
    p.spec.volumes = [{ name: 'isolation-handoff', emptyDir: {} }];
    p.spec.containers[0].volumeMounts = [{ name: 'isolation-handoff', mountPath: '/gromesh/handoff' }]; return p;
  });
  const target = await owner.containerTarget('own', 'target', 'app');
  const racing = new guard.N2Lab({ env: f.env, execute: async (cmd, args, options) => {
    const result = await f.execute(cmd, args, options);
    if (cmd === 'docker' && args.includes('inspect') && args.includes('crictl')) {
      const info = JSON.parse(result.stdout); info.info.runtimeSpec = { mounts: [{ destination: '/gromesh/handoff', source: '/foreign/volume' }] }; result.stdout = JSON.stringify(info);
    }
    return result;
  } });
  f.calls.length = 0;
  await assert.rejects(racing.writePodFile(target, 'isolation-handoff', 'applied.json', '{}'), /refused/);
  assert.equal(execMutations(f.calls).length, 0);
});

test('exit observation binds runtime container labels before polling by ID and refuses mismatched IDs', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture'); await ownedPod(f, owner);
  const observer = new guard.N2Lab({ env: f.env, execute: async (cmd, args, options) => {
    const result = await f.execute(cmd, args, options);
    if (cmd === 'docker' && args.includes('crictl') && args.includes('inspect')) {
      const info = JSON.parse(result.stdout); info.status.state = 'CONTAINER_EXITED'; info.status.finishedAt = '1234567890123456789'; info.status.exitCode = 0; result.stdout = JSON.stringify(info);
    }
    return result;
  } });
  f.calls.length = 0;
  const targets = await observer.exitTargets('own', 'target', { app: 'a'.repeat(64) });
  const result = await observer.watchContainerExits(targets, 1);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'a'.repeat(64) + ' CONTAINER_EXITED 1234567890123456789 0\n');
  assert.ok(f.calls.filter(c => c.cmd === 'docker' && c.args[0] === 'exec').every(c => c.args[1] === 'node-original' && c.args.includes('inspect')));
  await assert.rejects(owner.exitTargets('own', 'target', { app: 'b'.repeat(64) }), /refused/);
});

for (const operation of ['restart', 'upgrade']) for (const effect of ['deletion', 'status change']) {
  test(`post-${operation} detects unrelated ${effect} and preserves the ownership receipt`, async t => {
    const f = fixture(t), base = f.owner(); await base.createCluster('fixture'); const deployment = await ownedDeployment(f, base);
    f.helm([structuredClone(deployment)]);
    f.objects.set('pod/unrelated', { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'unrelated', namespace: 'own', uid: 'foreign', labels: { app: 'other' } }, status: { phase: 'Running' } });
    const receipt = readFileSync(base.statePath, 'utf8');
    const owner = new guard.N2Lab({ env: f.env, execute: async (cmd, args, options) => {
      const result = await f.execute(cmd, args, options);
      if ((operation === 'restart' && cmd === 'kubectl' && args.includes('apply')) || (operation === 'upgrade' && cmd === 'helm' && args.includes('upgrade'))) {
        if (effect === 'deletion') f.objects.delete('pod/unrelated');
        else f.objects.get('pod/unrelated').status.phase = 'Failed';
      }
      return result;
    } });
    await assert.rejects(operation === 'restart' ? owner.kubectl(['rollout', 'restart', '-n', 'own', 'deployment/app']) : owner.helm(['upgrade', 'dp', 'chart', '-n', 'own']), /refused/);
    assert.equal(readFileSync(base.statePath, 'utf8'), receipt);
    assert.ok(existsSync(join(f.env.LAB_EVIDENCE_DIR, 'n2-refused.json')));
  });
}

test('a new Helm storage revision needs its exact absent name and release payload, not selector labels', async t => {
  const { gzipSync } = await import('node:zlib');
  const f = fixture(t); await f.owner().createCluster('fixture'); await f.owner().kubectl(['create', '-f', '-'], { input: JSON.stringify(ns('own')) });
  const owner = new guard.N2Lab({ env: f.env, execute: async (cmd, args, options) => {
    const result = await f.execute(cmd, args, options);
    if (cmd === 'helm' && args.includes('upgrade')) {
      const release = { name: 'dp', namespace: 'own', version: 1, info: { status: 'deployed' }, manifest: JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [] }) };
      const data = Buffer.from(gzipSync(JSON.stringify(release)).toString('base64')).toString('base64');
      f.objects.set('secret/sh.helm.release.v1.dp.v1', { apiVersion: 'v1', kind: 'Secret', type: 'helm.sh/release.v1',
        metadata: { name: 'sh.helm.release.v1.dp.v1', namespace: 'own', uid: 'created-revision-1', resourceVersion: '7', labels: { owner: 'helm', name: 'dp', version: '1', status: 'deployed' } }, data: { release: data } });
    }
    return result;
  } });
  await owner.helm(['upgrade', '--install', 'dp', 'chart', '-n', 'own']);
  assert.equal(JSON.parse(readFileSync(owner.statePath)).resources['secret/own/sh.helm.release.v1.dp.v1'], 'created-revision-1');
});

test('Helm success without a demonstrable new storage revision refuses to save release receipts', async t => {
  const f = fixture(t); await f.owner().createCluster('fixture'); await f.owner().kubectl(['create', '-f', '-'], { input: JSON.stringify(ns('own')) });
  const owner = new guard.N2Lab({ env: f.env, execute: async (cmd, args, options) => {
    const result = await f.execute(cmd, args, options);
    if (cmd === 'helm' && args.includes('upgrade')) for (const key of f.objects.keys()) if (key.startsWith('secret/sh.helm.release.')) f.objects.delete(key);
    return result;
  } });
  await assert.rejects(owner.helm(['upgrade', 'dp', 'chart', '-n', 'own']), /refused/);
  assert.equal(JSON.parse(readFileSync(owner.statePath)).releases?.['own/dp'], undefined);
});

test('CoreDNS restart proves its creation baseline and labels replacement descendants for later checks', async t => {
  const f = fixture(t);
  f.objects.set('deployment/coredns', { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'coredns', namespace: 'kube-system', uid: 'core-created', resourceVersion: '3' },
    spec: { selector: { matchLabels: { app: 'dns' } }, template: { metadata: { labels: { app: 'dns' } }, spec: {} } } });
  await f.owner().createCluster('fixture');
  const owner = new guard.N2Lab({ env: f.env, execute: async (cmd, args, options) => {
    const result = await f.execute(cmd, args, options);
    if (cmd === 'kubectl' && args.includes('apply')) {
      const parent = f.objects.get('deployment/coredns');
      f.objects.set('replicaset/new-dns', { apiVersion: 'apps/v1', kind: 'ReplicaSet', metadata: { name: 'new-dns', namespace: 'kube-system', uid: 'new-dns', creationTimestamp: new Date().toISOString(), managedFields: [{ manager: 'kube-controller-manager', operation: 'Update' }], labels: { ...parent.spec.template.metadata.labels, 'pod-template-hash': 'dns123' },
        ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: 'coredns', uid: 'core-created', controller: true }] }, spec: { selector: parent.spec.selector, template: { ...parent.spec.template, metadata: { ...parent.spec.template.metadata, labels: { ...parent.spec.template.metadata.labels, 'pod-template-hash': 'dns123' } } } } });
    }
    return result;
  } });
  await owner.kubectl(['rollout', 'restart', '-n', 'kube-system', 'deployment/coredns']);
  assert.equal(owner.load().resources['deployment/kube-system/coredns'], 'core-created');
  assert.equal(f.objects.get('replicaset/new-dns').metadata.labels[label], f.env.LAB_RUN_ID);
});

test('Helm and its separate renderer inherit the proved copy after the original kubeconfig changes', async t => {
  const f = fixture(t); await f.owner().createCluster('fixture'); await f.owner().kubectl(['create', '-f', '-'], { input: JSON.stringify(ns('own')) });
  f.helm([{ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'chart-config' }, data: { mode: 'test' } }]);
  const owner = new guard.N2Lab({ env: f.env, execute: async (cmd, args, options) => {
    if (cmd === 'helm' && args.includes('upgrade')) {
      writeFileSync(f.env.LAB_KUBECONFIG, 'replacement cluster');
      const path = args[args.indexOf('--kubeconfig') + 1];
      assert.notEqual(path, f.env.LAB_KUBECONFIG);
      assert.equal(options.env.KUBECONFIG, path);
      assert.equal(options.env.LAB_N2_PINNED_CONFIG, path);
      assert.equal(readFileSync(path, 'utf8'), 'exclusive config');
    }
    return f.execute(cmd, args, options);
  } });
  await owner.helm(['upgrade', '--install', 'dp', 'chart', '-n', 'own']);
  assert.equal(owner.load().resources['configmap/own/chart-config'], 'created-chart-config');
});

for (const mismatch of ['release-name', 'release-namespace', 'missing annotations', 'previous UID']) {
  test(`post-upgrade refuses a chart object with ${mismatch} before granting ownership`, async t => {
    const f = fixture(t); await f.owner().createCluster('fixture'); await f.owner().kubectl(['create', '-f', '-'], { input: JSON.stringify(ns('own')) });
    f.helm([{ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'chart-config' } }]);
    if (mismatch === 'previous UID') f.objects.set('configmap/unrelated', { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'unrelated', namespace: 'own', uid: 'foreign-old' } });
    const owner = new guard.N2Lab({ env: f.env, execute: async (cmd, args, options) => {
      const result = await f.execute(cmd, args, options);
      if (cmd === 'helm' && args.includes('upgrade')) {
        const o = f.objects.get('configmap/chart-config');
        if (mismatch === 'missing annotations') delete o.metadata.annotations;
        else if (mismatch === 'previous UID') o.metadata.uid = 'foreign-old';
        else o.metadata.annotations['meta.helm.sh/' + mismatch] = 'foreign';
      }
      return result;
    } });
    f.calls.length = 0;
    await assert.rejects(owner.helm(['upgrade', 'dp', 'chart', '-n', 'own']), /refused/);
    assert.equal(JSON.parse(readFileSync(owner.statePath)).resources['configmap/own/chart-config'], undefined);
    assert.ok(!f.calls.some(c => c.cmd === 'kubectl' && c.args.includes('label')));
  });
}

test('collector probe resolves the owned pod IP and uses fixed ports on the bound Docker node ID', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture'); const p = await ownedPod(f, owner, p => { p.spec.containers[0].name = 'collector'; p.status.containerStatuses[0].name = 'collector'; return p; });
  p.status.podIP = '10.0.0.7';
  const target = await owner.containerTarget('own', 'target', 'collector'); f.calls.length = 0;
  await owner.collectorProbe('gromesh-n2-bafd0b463f146039e73843bd-control-plane', target);
  const call = f.calls.find(c => c.cmd === 'docker' && c.args.includes('bash'));
  assert.equal(call.args[1], 'node-original');
  assert.equal(call.args.at(-1), '10.0.0.7');
  assert.match(call.args[4], /for p in 8080 9598/);
  p.metadata.uid = 'replaced'; f.calls.length = 0;
  await assert.rejects(owner.collectorProbe('gromesh-n2-bafd0b463f146039e73843bd-control-plane', target), /refused/);
  assert.equal(execMutations(f.calls).length, 0);
});

test('a proved handoff write binds the runtime mount and refuses traversal', async t => {
  const f = fixture(t); await f.owner().createCluster('fixture'); const base = f.owner(), p = await ownedPod(f, base, p => {
    p.spec.volumes = [{ name: 'isolation-handoff', emptyDir: {} }];
    p.spec.containers[0].volumeMounts = [{ name: 'isolation-handoff', mountPath: '/gromesh/handoff' }]; return p;
  });
  const owner = new guard.N2Lab({ env: f.env, execute: async (cmd, args, options) => {
    const result = await f.execute(cmd, args, options);
    if (cmd === 'docker' && args.includes('inspect') && args.includes('crictl')) {
      const info = JSON.parse(result.stdout); info.info.runtimeSpec = { mounts: [{ destination: '/gromesh/handoff', source: '/var/lib/kubelet/pods/created-target/volumes/kubernetes.io~empty-dir/isolation-handoff' }] }; result.stdout = JSON.stringify(info);
    }
    return result;
  } });
  const target = await owner.containerTarget('own', 'target', 'app'); f.calls.length = 0;
  await owner.writePodFile(target, 'isolation-handoff', 'applied.json', '{"revision":7}');
  const call = f.calls.find(c => c.cmd === 'docker' && c.args.includes('sh'));
  assert.equal(call.args[2], 'node-original');
  assert.equal(call.args.at(-2), '/var/lib/kubelet/pods/created-target/volumes/kubernetes.io~empty-dir/isolation-handoff/applied.json');
  assert.equal(call.input, '{"revision":7}');
  f.calls.length = 0;
  await assert.rejects(owner.readPodFile(target, 'isolation-handoff', '../foreign'), /refused/);
  assert.equal(execMutations(f.calls).length, 0);
});

test('streamed logs use the proved private configuration after the source is replaced', async t => {
  const { EventEmitter } = await import('node:events');
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  writeFileSync(f.env.LAB_KUBECONFIG, 'other cluster');
  const source = readFileSync(new URL('./components/run.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('class Follower'), source.indexOf('// Every instant'));
  let selected;
  const child = new EventEmitter(); child.stdout = new EventEmitter();
  runInNewContext(body + '\nnew Follower("target", "app")', { ownership: owner, kubeconfig: f.env.LAB_KUBECONFIG, CONTEXT: owner.context, NS: { dp: 'own' },
    spawn: (cmd, args) => { selected = args[args.indexOf('--kubeconfig') + 1]; return child; }, parseLine: () => {} });
  assert.notEqual(selected, f.env.LAB_KUBECONFIG);
  assert.equal(readFileSync(selected, 'utf8'), 'exclusive config');
});

// R7 Model H regressions: all executors above are in-memory or temporary fixture programs.
test('R7 cluster name is unique to the run and rejects the preserved N2 lab', async t => {
  const f = fixture(t), owner = f.owner();
  assert.notEqual(owner.cluster, 'gromesh-n2-lab');
  assert.notEqual(owner.cluster, new guard.N2Lab({ env: { ...f.env, LAB_RUN_ID: 'another-run-123456' }, execute: f.execute }).cluster);
  await owner.createCluster('fixture');
  const state = owner.load();
  assert.equal(state.creation.model, 'H');
  assert.equal(state.creation.runId, f.env.LAB_RUN_ID);
  assert.equal(state.creation.exclusive, true);
});

test('R7 namespace replacement at final identity check stops before create and latches retry', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  await owner.kubectl(['create', '-f', '-'], { input: JSON.stringify(ns('own')) });
  const racing = f.owner(), original = racing.assertIdentity.bind(racing); let checks = 0;
  racing.assertIdentity = async () => { const state = await original(); if (++checks === 2) f.objects.get('namespace/own').metadata.uid = 'foreign'; return state; };
  f.calls.length = 0;
  await assert.rejects(racing.kubectl(['create', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'new', namespace: 'own' } }) }), /refused/);
  assert.equal(mutations(f.calls).length, 0);
  f.calls.length = 0; await assert.rejects(f.owner().image(['clean']), /refused/);
  assert.equal(f.calls.length, 0);
});

test('R7 foreign object anywhere stops an unrelated mutation and preserves first evidence', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  f.objects.set('pod/foreign', { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'foreign', namespace: 'default', uid: 'foreign' } });
  f.calls.length = 0;
  await assert.rejects(owner.image(['tag', 'source', 'new:' + f.env.LAB_RUN_ID]), /refused/);
  assert.equal(mutations(f.calls).length, 0);
  const marker = readFileSync(owner.refusalPath, 'utf8');
  assert.ok(existsSync(join(f.env.LAB_EVIDENCE_DIR, 'n2-inventory-exclusive.json')));
  f.objects.clear(); f.calls.length = 0;
  await assert.rejects(f.owner().destroyCluster(), /refused/);
  assert.equal(f.calls.length, 0);
  assert.equal(readFileSync(owner.refusalPath, 'utf8'), marker);
});

test('R7 forged controller reference and copied labels with wrong template image never grant exec', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture'); const deployment = await ownedDeployment(f, owner);
  const rs = { apiVersion: 'apps/v1', kind: 'ReplicaSet', metadata: { ...f.metadata('rs'), namespace: 'own', ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: 'app', uid: deployment.metadata.uid, controller: true }] }, spec: { selector: deployment.spec.selector, template: deployment.spec.template } };
  await owner.kubectl(['create', '-f', '-'], { input: JSON.stringify(rs) });
  f.objects.set('pod/forged', { apiVersion: 'v1', kind: 'Pod', metadata: { ...f.metadata('forged'), namespace: 'own', ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'rs', uid: 'rs', controller: true }] }, spec: { nodeName: f.node.Config.Hostname, containers: [{ name: 'app', image: 'foreign' }] }, status: { containerStatuses: [{ name: 'app', containerID: 'containerd://' + 'b'.repeat(64) }] } });
  f.calls.length = 0;
  await assert.rejects(owner.kubectl(['exec', '-n', 'own', 'forged', '--', 'true']), /refused/);
  assert.equal(execMutations(f.calls).length, 0);
});

test('R7 known system coordination renewals are excluded, third party Leases are not', async t => {
  const f = fixture(t), owner = f.owner();
  const lease = { apiVersion: 'coordination.k8s.io/v1', kind: 'Lease', metadata: { name: f.node.Config.Hostname, namespace: 'kube-node-lease', uid: 'system-lease' }, spec: { holderIdentity: f.node.Config.Hostname, renewTime: 'before' } };
  assert.equal(owner.systemCoordination(lease, { nodes: [{ nodeName: f.node.Config.Hostname }] }), true);
  assert.equal(owner.systemCoordination({ ...lease, metadata: { ...lease.metadata, namespace: 'own' } }, { nodes: [] }), false);
  assert.equal(owner.baselineProof(lease), owner.baselineProof({ ...lease, spec: { ...lease.spec, renewTime: 'after' } }));
});

for (const operation of ['restart', 'upgrade']) {
  test(`R7 ${operation} refuses a pod entering its ReplicaSet during the boundary inventory`, async t => {
    const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture'); const deployment = await ownedDeployment(f, owner);
    await owner.kubectl(['create', '-f', '-'], { input: JSON.stringify({ apiVersion: 'apps/v1', kind: 'ReplicaSet', metadata: { name: 'rs', namespace: 'own', ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: 'app', uid: deployment.metadata.uid, controller: true }] }, spec: { selector: deployment.spec.selector, template: deployment.spec.template } }) });
    f.helm([deployment]);
    const racing = f.owner(), original = racing.rolloutInventory.bind(racing); let armed = true;
    racing.rolloutInventory = async (...args) => { const result = await original(...args); if (armed) { armed = false; f.objects.set('pod/intruder', { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'intruder', namespace: 'own', uid: 'intruder', labels: { app: 'target' }, ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'rs', uid: 'created-rs', controller: true }] } }); } return result; };
    f.calls.length = 0;
    await assert.rejects(operation === 'restart' ? racing.kubectl(['rollout', 'restart', '-n', 'own', 'deployment/app']) : racing.helm(['upgrade', 'dp', 'chart', '-n', 'own']), /refused/);
    assert.equal(mutations(f.calls).length, 0);
    assert.ok(existsSync(racing.refusalPath));
  });
}

test('R7 namespace swapped inside CREATE preserves evidence and forbids every later write', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture'); await ownedPod(f, owner);
  const racing = new guard.N2Lab({ env: f.env, execute: async (cmd, args, opts) => {
    const result = await f.execute(cmd, args, opts);
    if (cmd === 'kubectl' && args.includes('create') && !args.includes('--dry-run=client')) f.objects.get('namespace/own').metadata.uid = 'replacement';
    return result;
  } });
  const receipt = readFileSync(owner.statePath, 'utf8'); f.calls.length = 0;
  await assert.rejects(racing.kubectl(['create', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'raced', namespace: 'own' } }) }), /refused/);
  assert.equal(mutations(f.calls).length, 1, 'H detects this non-atomic CREATE race after the write, never claims prevention');
  assert.equal(readFileSync(owner.statePath, 'utf8'), receipt);
  f.calls.length = 0; await assert.rejects(f.owner().docker(['rm', '-f', 'anything']), /refused/); assert.equal(f.calls.length, 0);
});

for (const kind of ['PersistentVolume', 'CustomResourceDefinition', 'MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration', 'ClusterRoleBinding', 'ServiceAccount', 'Lease', 'DaemonSet']) {
  test(`R7 exclusivity refuses unexpected ${kind} before any unrelated write`, async t => {
    const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
    const namespaced = ['ServiceAccount', 'Lease', 'DaemonSet'].includes(kind);
    f.objects.set(kind.toLowerCase() + '/foreign', { apiVersion: kind === 'Lease' ? 'coordination.k8s.io/v1' : 'v1', kind, metadata: { name: 'foreign', uid: 'foreign', ...(namespaced ? { namespace: 'default' } : {}) }, ...(kind === 'ClusterRoleBinding' ? { subjects: [{ kind: 'User', name: 'external-user' }] } : {}) });
    f.calls.length = 0; await assert.rejects(owner.image(['tag', 'source', 't:' + f.env.LAB_RUN_ID]), /refused/); assert.equal(mutations(f.calls).length, 0);
  });
}

test('R7 system Lease renewal during rollout passes; a third party Lease still stops it', async t => {
  const f = fixture(t), base = f.owner();
  const lease = { apiVersion: 'coordination.k8s.io/v1', kind: 'Lease', metadata: { name: f.node.Config.Hostname, namespace: 'kube-node-lease', uid: 'system-lease' }, spec: { holderIdentity: f.node.Config.Hostname, renewTime: '0' } };
  f.objects.set('lease/' + lease.metadata.name, lease);
  await base.createCluster('fixture'); await ownedDeployment(f, base);
  const owner = new guard.N2Lab({ env: f.env, execute: async (cmd, args, opts) => { const result = await f.execute(cmd, args, opts); if (cmd === 'kubectl' && args.includes('apply')) lease.spec.renewTime = 'renewed'; return result; } });
  await owner.kubectl(['rollout', 'restart', '-n', 'own', 'deployment/app']);
  assert.equal(lease.spec.renewTime, 'renewed');
  f.objects.set('lease/third-party', { ...lease, metadata: { name: 'third-party', namespace: 'kube-node-lease', uid: 'foreign' } }); f.calls.length = 0;
  await assert.rejects(owner.kubectl(['rollout', 'restart', '-n', 'own', 'deployment/app']), /refused/); assert.equal(mutations(f.calls).length, 0);
});

test('R7 declared header invariants are exercised and remain H, with P and gates unchanged', async t => {
  const header = readFileSync(new URL('../../../scripts/kind-stack-guard.mjs', import.meta.url), 'utf8').split('import ')[0];
  for (const invariant of ['EXCLUSIVE', 'persistent STOP', 'ALL further mutations', 'including cleanup', 'template/hash/image', 'no atomic UID/inventory fence', 'trusted operator', 'Shared clusters', 'Model P/W0 is unchanged', 'approve no gate', 'no degraded mode']) assert.ok(header.includes(invariant), invariant);
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  const state = owner.load();
  assert.notEqual(state.cluster, 'gromesh-n2-lab'); assert.equal(state.creation.model, 'H');
  assert.equal(state.creation.exclusive, true); assert.equal(state.runId, f.env.LAB_RUN_ID);
  const receipt = readFileSync(owner.statePath, 'utf8'); f.calls.length = 0;
  await assert.rejects(owner.assertExclusive({ ...state, creation: { ...state.creation, exclusive: false } }), /refused/);
  for (const operation of [() => f.owner().kubectl(['create', '-f', '-'], { input: JSON.stringify(ns('later')) }),
    () => f.owner().helm(['upgrade', 'x', 'chart', '-n', 'kube-system']), () => f.owner().image(['clean']),
    () => f.owner().docker(['rm', '-f', 'later']), () => f.owner().destroyCluster()]) await assert.rejects(operation(), /refused/);
  assert.equal(f.calls.length, 0); assert.equal(readFileSync(owner.statePath, 'utf8'), receipt);
  assert.ok(existsSync(owner.refusalPath));

});

test('R7 a second guard operation on the same run triggers STOP instead of concurrent mutation', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  let release; const pending = new Promise(resolve => { release = resolve; });
  const first = owner.withOperation(async () => { await pending; return owner.execute('docker', ['tag', 'source', 'x']); });
  await new Promise(resolve => setImmediate(resolve));
  f.calls.length = 0;
  await assert.rejects(f.owner().image(['tag', 'source', 't:' + f.env.LAB_RUN_ID]), /refused/);
  release(); await assert.rejects(first, /refused/);
  assert.equal(mutations(f.calls).length, 0);
});

test('R7 owned UID and labels do not hide an unexpected template change', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture'); const dep = await ownedDeployment(f, owner);
  dep.spec.template.spec.containers = [{ name: 'foreign', image: 'foreign' }];
  f.calls.length = 0;
  await assert.rejects(owner.image(['tag', 'source', 't:' + f.env.LAB_RUN_ID]), /refused/); assert.equal(mutations(f.calls).length, 0);
});

test('R7 controller-created ReplicaSet and pod receive template-bound receipts before exec', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture');
  const original = await ownedDeployment(f, owner), desired = structuredClone(original);
  desired.spec.template.spec.containers = [{ name: 'app', image: 'owned:fixture' }];
  await owner.kubectl(['apply', '-f', '-'], { input: JSON.stringify(desired) });
  const dep = f.objects.get('deployment/app');
  const labels = { ...dep.spec.template.metadata.labels, 'pod-template-hash': 'abc123' }, template = { ...dep.spec.template, metadata: { labels } };
  const metadata = name => ({ ...f.metadata(name), namespace: 'own', labels, creationTimestamp: new Date().toISOString(), managedFields: [{ manager: 'kube-controller-manager', operation: 'Update' }] });
  f.objects.set('replicaset/rs', { apiVersion: 'apps/v1', kind: 'ReplicaSet', metadata: { ...metadata('rs'), ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: 'app', uid: dep.metadata.uid, controller: true }] }, spec: { selector: dep.spec.selector, template } });
  f.objects.set('pod/child', { apiVersion: 'v1', kind: 'Pod', metadata: { ...metadata('child'), ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'rs', uid: 'rs', controller: true }] }, spec: { ...template.spec, nodeName: f.node.Config.Hostname }, status: { containerStatuses: [{ name: 'app', containerID: 'containerd://' + 'a'.repeat(64) }] } });
  await owner.assertIdentity();
  const receipts = owner.load().controllerReceipts;
  assert.equal(receipts['pod/own/child'].controllerUid, 'rs'); assert.equal(receipts['pod/own/child'].templateHash, 'abc123');
  const pod = f.objects.get('pod/child'); pod.metadata.resourceVersion = '1';
  const target = await owner.containerTarget('own', 'child');
  assert.equal((await owner.execContainer(target, ['true'])).stdout, 'owned output');
  pod.metadata.resourceVersion = '2'; f.calls.length = 0;
  await assert.rejects(owner.execContainer(target, ['true']), /refused/); assert.equal(execMutations(f.calls).length, 0);
});

for (const shared of ['hostPath', 'nfs']) test(`R7 ${shared} manifests stop before resource creation`, async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture'); await owner.kubectl(['create', '-f', '-'], { input: JSON.stringify(ns('own')) });
  f.calls.length = 0;
  await assert.rejects(owner.kubectl(['create', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'bad', namespace: 'own' }, spec: { volumes: [{ name: 'shared', [shared]: { path: '/foreign' } }] } }) }), /refused/);
  assert.equal(mutations(f.calls).length, 0);
});

test('R7 creation refuses an extra system-prefixed role rather than baselining its name', async t => {
  const f = fixture(t), owner = f.owner();
  f.objects.set('clusterrole/system:foreign', { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'system:foreign', uid: 'foreign' } });
  await assert.rejects(owner.createCluster('fixture'), /refused/);
  assert.ok(!f.calls.some(c => c.cmd === 'kubectl' && c.args.includes('label')));
});

test('R7 provisioning rejects declared shared kind mounts before kind create', async t => {
  const f = fixture(t), owner = f.owner();
  await assert.rejects(owner.createCluster('nodes:\n- role: control-plane\n  extraMounts:\n  - hostPath: /foreign\n    containerPath: /data'), /refused/);
  assert.equal(mutations(f.calls).length, 0);
});

test('R7 namespace system outputs are expected only for this run and foreign accounts still stop', async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture'); await ownedPod(f, owner);
  f.objects.set('serviceaccount/default', { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'default', namespace: 'own', uid: 'default-own', creationTimestamp: new Date().toISOString(), managedFields: [{ manager: 'kube-controller-manager', operation: 'Update' }] } });
  await owner.assertIdentity();
  f.objects.set('serviceaccount/extra', { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'extra', namespace: 'own', uid: 'extra' } }); f.calls.length = 0;
  await assert.rejects(owner.image(['clean']), /refused/); assert.equal(mutations(f.calls).length, 0);
});

test('R7 an unrelated recorded resource disappearing during rollout latches STOP after the write', async t => {
  const f = fixture(t), base = f.owner(); await base.createCluster('fixture'); await ownedDeployment(f, base);
  await base.kubectl(['create', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'unrelated', namespace: 'own' } }) });
  const receipt = readFileSync(base.statePath, 'utf8');
  const racing = new guard.N2Lab({ env: f.env, execute: async (cmd, args, opts) => { const result = await f.execute(cmd, args, opts); if (cmd === 'kubectl' && args.includes('apply')) f.objects.delete('configmap/unrelated'); return result; } });
  await assert.rejects(racing.kubectl(['rollout', 'restart', '-n', 'own', 'deployment/app']), /refused/);
  assert.equal(readFileSync(base.statePath, 'utf8'), receipt);
});

test('R7 a mutation that loses exclusivity before returning discards success and blocks cleanup', async t => {
  const f = fixture(t), base = f.owner(); await base.createCluster('fixture');
  const racing = new guard.N2Lab({ env: f.env, execute: async (cmd, args, options) => {
    const result = await f.execute(cmd, args, options);
    if (cmd === 'docker' && args[0] === 'tag') f.objects.set('pod/concurrent', { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'concurrent', namespace: 'default', uid: 'foreign' } });
    return result;
  } });
  await assert.rejects(racing.image(['tag', 'source', 't:' + f.env.LAB_RUN_ID]), /refused/);
  f.calls.length = 0; await assert.rejects(f.owner().image(['clean']), /refused/); assert.equal(f.calls.length, 0);
});

for (const object of [
  { apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: 'foreign-storage' }, spec: { nfs: { server: 'third-party', path: '/shared' } } },
  { apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: { name: 'external' }, provisioner: 'third-party.example/nfs' },
]) test(`R7 ${object.kind} cannot introduce external storage through an owned manifest`, async t => {
  const f = fixture(t), owner = f.owner(); await owner.createCluster('fixture'); f.calls.length = 0;
  await assert.rejects(owner.kubectl(['create', '-f', '-'], { input: JSON.stringify(object) }), /refused/); assert.equal(mutations(f.calls).length, 0);
});
