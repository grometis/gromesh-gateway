import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { assertLocalDaemon, daemonProblems } from "./stack-guard.mjs";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, readlinkSync, existsSync, lstatSync, statSync, realpathSync, renameSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
const fail = () => new Error("Kind test stack refused before any write: ownership, kubeconfig or port-forward proof missing");
export function kindClusterName(run) {
  return `gromesh-mvp-${createHash("sha256").update(run).digest("hex").slice(0, 32)}`;
}
export function kindProblems(env, node, current, exported) {
  const problems = [];
  const name = env.KIND_CLUSTER_NAME;
  if (!name || name === "gromesh-mvp" || !/^[a-z0-9][a-z0-9-]+$/.test(name))
    problems.push("KIND_CLUSTER_NAME");
  if (!/^[a-zA-Z0-9_-]{12,128}$/.test(env.GROMESH_DISPOSABLE_ID ?? ""))
    problems.push("GROMESH_DISPOSABLE_ID");
  else if (name !== kindClusterName(env.GROMESH_DISPOSABLE_ID))
    problems.push("kind cluster does not belong to this execution ID");
  if (!env.KUBECONFIG)
    problems.push("KUBECONFIG");
  return [...problems, ...clusterIdentityProblems(name, node, current, exported)];
}
function clusterIdentityProblems(name, node, current, exported) {
  const problems = [];
  if (node?.Config?.Labels?.["io.x-k8s.kind.cluster"] !== name || node?.State?.Running !== true)
    problems.push("kind node");
  if (current?.contexts?.[0]?.context?.cluster !== `kind-${name}` || current?.["current-context"] !== `kind-${name}`)
    problems.push("context");
  const cluster = current?.clusters?.[0]?.cluster, expected = exported?.clusters?.[0]?.cluster;
  if (!cluster?.server || !cluster?.["certificate-authority-data"] || cluster.server !== expected?.server
    || cluster["certificate-authority-data"] !== expected?.["certificate-authority-data"])
    problems.push("server/CA");
  try {
    const url = new URL(cluster.server);
    const bindings = node.NetworkSettings.Ports["6443/tcp"];
    if (url.protocol !== "https:" || !["127.0.0.1", "localhost"].includes(url.hostname) || !bindings?.some(b => b.HostPort === url.port && ["127.0.0.1", "0.0.0.0"].includes(b.HostIp)))
      problems.push("API binding");
  }
  catch {
    problems.push("API binding");
  }
  return problems;
}
async function exec(file, args) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(fail()) : resolve(String(stdout))));
}
// Linux CI: bind ownership is proved by the socket inode in the actual kubectl process's fd table.
// Merely having a PID environment variable or a responsive localhost endpoint is insufficient.
export function listeningPorts(pid, read = readFileSync, list = readdirSync, link = readlinkSync) {
  if (!/^[1-9][0-9]*$/.test(String(pid)))
    throw fail();
  const sockets = new Set(list(`/proc/${pid}/fd`).flatMap(fd => {
    try {
      const m = /^socket:\[(\d+)\]$/.exec(link(`/proc/${pid}/fd/${fd}`));
      return m ? [m[1]] : [];
    }
    catch {
      return [];
    }
  }));
  return new Set(read(`/proc/${pid}/net/tcp`, "utf8").split("\n").slice(1).flatMap(line => {
    const f = line.trim().split(/\s+/);
    if (f[3] !== "0A" || !sockets.has(f[9]))
      return [];
    const [host, port] = f[1].split(":");
    return host === "0100007F" ? [parseInt(port, 16)] : [];
  }));
}
export async function assertKindStack(scope = "cluster", env = process.env) {
  let dir;
  try {
    if (!env.KIND_CLUSTER_NAME || !env.KUBECONFIG || !env.GROMESH_DISPOSABLE_ID)
      throw fail();
    await assertLocalDaemon(env);
    const node = JSON.parse(await exec("docker", ["inspect", `${env.KIND_CLUSTER_NAME}-control-plane`]))[0];
    const current = JSON.parse(await exec("kubectl", ["--kubeconfig", env.KUBECONFIG, "config", "view", "--raw", "--minify", "-o", "json"]));
    const yaml = await exec("kind", ["get", "kubeconfig", "--name", env.KIND_CLUSTER_NAME]);
    dir = mkdtempSync(join(tmpdir(), "gromesh-kind-proof-"));
    const file = join(dir, "config");
    writeFileSync(file, yaml, { mode: 0o600 });
    const exported = JSON.parse(await exec("kubectl", ["--kubeconfig", file, "config", "view", "--raw", "--minify", "-o", "json"]));
    if (kindProblems(env, node, current, exported).length)
      throw fail();
    if (scope === "cluster")
      return;
    if (scope !== "acceptance" || !env.E2E_NAMESPACE || !env.E2E_ADMIN_PASSWORD || !env.E2E_ENV_ID || !env.E2E_CLUSTER_ID)
      throw fail();
    const ns = JSON.parse(await exec("kubectl", ["--kubeconfig", env.KUBECONFIG, "--context", `kind-${env.KIND_CLUSTER_NAME}`, "get", "namespace", env.E2E_NAMESPACE, "-o", "json"]));
    if (ns.metadata?.labels?.["com.grometis.gromesh.disposable"] !== env.GROMESH_DISPOSABLE_ID)
      throw fail();
    const forwards = [["UI_URL", "KIND_UI_FORWARD_PID", "cp-control-plane-ui", 8080], ["CP_URL", "KIND_CP_FORWARD_PID", "control-plane", 3000], ["KONG_PROXY_URL", "KIND_PROXY_FORWARD_PID", "mvp-data-plane", 8000]];
    for (const [variable, pidVariable, service, remote] of forwards) {
      const url = new URL(env[variable]);
      const pid = env[pidVariable];
      if (url.hostname !== "127.0.0.1" || url.protocol !== "http:" || url.username || url.password || !listeningPorts(pid).has(Number(url.port)))
        throw fail();
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      const inherited = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      if (!inherited.includes(`KUBECONFIG=${env.KUBECONFIG}`))
        throw fail();
      const hasPair = (a, b) => cmd.some((v, i) => v === a && cmd[i + 1] === b);
      if (!cmd[0]?.endsWith("kubectl") || !hasPair("--context", `kind-${env.KIND_CLUSTER_NAME}`) || !hasPair("-n", env.E2E_NAMESPACE)
        || !cmd.includes("port-forward") || !hasPair("--address", "127.0.0.1") || !cmd.includes(`svc/${service}`) || !cmd.includes(`${url.port}:${remote}`))
        throw fail();
    }
  }
  catch {
    throw fail();
  }
  finally {
    if (dir)
      rmSync(dir, { recursive: true, force: true });
  }
}

export const n2RunLabel = 'com.grometis.gromesh.n2-run';
export const n2LabLabel = 'com.grometis.gromesh.lab';
const n2Refused = reason => new Error(`N2 lab refused before mutation: ${reason}; ownership proof and evidence preserved`);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const resourceKey = o => `${o.kind.toLowerCase()}/${o.metadata.namespace ?? ''}/${o.metadata.name}`;
const flagValue = (args, ...flags) => {
  for (const flag of flags) {
    const index = args.indexOf(flag);
    if (index >= 0) return args[index + 1];
    const pair = args.find(a => a.startsWith(`${flag}=`));
    if (pair) return pair.slice(flag.length + 1);
  }
};
async function n2Execute(command, args, { input, env = process.env, timeout = 180_000, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 || allowFail) resolve({ code, stdout, stderr });
      else reject(new Error(`${command} failed (exit ${code})`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

// N2 uses the same kind endpoint/CA/node proof as CI, plus a creation receipt. A name, even a labelled
// object, cannot establish that this run created it. Missing receipts are never reconstructed from a live cluster.
export class N2Lab {
  constructor({ env = process.env, execute = n2Execute } = {}) {
    this.env = { ...env, KUBECONFIG: env.LAB_KUBECONFIG };
    this.execute = (command, args, options = {}) => execute(command, args, { ...options, env: { ...this.env, ...options.env } });
    this.cluster = 'gromesh-n2-lab';
    this.context = `kind-${this.cluster}`;
    this.kubeconfig = env.LAB_KUBECONFIG;
    this.statePath = `${this.kubeconfig}.n2-owner.json`;
    this.refused = false;
    this.queue = Promise.resolve();
  }
  refuse(reason) { this.refused = true; throw n2Refused(reason); }
  pathProof(creating = false) {
    const file = this.kubeconfig, home = this.env.HOME ?? homedir();
    if (!file || file.includes(':')) this.refuse('exclusive LAB_KUBECONFIG required');
    const canonical = join(realpathSync(dirname(resolve(file))), resolve(file).split('/').at(-1));
    const globalPath = existsSync(join(home, '.kube')) ? join(realpathSync(join(home, '.kube')), 'config') : resolve(home, '.kube/config');
    if (canonical === globalPath) this.refuse('global kubeconfig');
    if (existsSync(file)) {
      const st = lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) this.refuse('kubeconfig is not an exclusive regular file');
      if (existsSync(join(home, '.kube/config'))) {
        const global = statSync(join(home, '.kube/config'));
        if (st.dev === global.dev && st.ino === global.ino) this.refuse('global kubeconfig inode');
      }
      if (creating) this.refuse('preexisting kubeconfig');
    } else if (!creating) this.refuse('missing kubeconfig');
    return canonical;
  }
  load() {
    const path = this.pathProof();
    const st = lstatSync(this.statePath);
    if (!st.isFile() || st.nlink !== 1 || st.isSymbolicLink()) this.refuse('invalid creation receipt');
    const state = JSON.parse(readFileSync(this.statePath, 'utf8'));
    const kc = statSync(this.kubeconfig);
    if (state.phase !== 'ready' || state.cluster !== this.cluster || state.context !== this.context || state.kubeconfig !== path
      || state.kubeconfigInode !== `${kc.dev}:${kc.ino}` || state.kubeconfigHash !== sha256(readFileSync(this.kubeconfig)) || !/^[a-z0-9-]{12,63}$/.test(state.runId ?? '')
      || (this.env.LAB_RUN_ID && this.env.LAB_RUN_ID !== state.runId)) this.refuse('creation receipt does not match this execution');
    return state;
  }
  save(state) {
    const temp = `${this.statePath}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(temp, this.statePath);
  }
  async rawK(args, options) {
    return this.execute('kubectl', ['--kubeconfig', this.kubeconfig, '--context', this.context, ...args], options);
  }
  async get(type, name, namespace) {
    const { stdout } = await this.rawK(['get', type, ...(name ? [name] : []), ...(namespace ? ['-n', namespace] : []), '--ignore-not-found', '-o', 'json']);
    return stdout.trim() ? JSON.parse(stdout) : null;
  }
  async daemon() {
    const context = JSON.parse((await this.execute('docker', ['context', 'inspect'])).stdout)[0];
    // Shared with the Compose guard: no remote DOCKER_HOST or Docker context.
    if (daemonProblems(this.env, context).length) this.refuse('Docker daemon is not local');
  }
  async identity() {
    const current = JSON.parse((await this.rawK(['config', 'view', '--raw', '--flatten', '-o', 'json'])).stdout);
    const yaml = (await this.execute('kind', ['get', 'kubeconfig', '--name', this.cluster])).stdout;
    const dir = mkdtempSync(join(tmpdir(), 'gromesh-kind-proof-'));
    let exported;
    try {
      const file = join(dir, 'config'); writeFileSync(file, yaml, { mode: 0o600 });
      exported = JSON.parse((await this.execute('kubectl', ['--kubeconfig', file, '--context', this.context, 'config', 'view', '--raw', '--flatten', '-o', 'json'])).stdout);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    const node = JSON.parse((await this.execute('docker', ['inspect', `${this.cluster}-control-plane`])).stdout)[0];
    if (current.contexts?.length !== 1 || current.clusters?.length !== 1
      || clusterIdentityProblems(this.cluster, node, current, exported).length) this.refuse('cluster context, endpoint or CA differs');
    const system = await this.get('namespace', 'kube-system');
    if (!system?.metadata?.uid) this.refuse('kube-system UID missing');
    return { marker: system.metadata.labels?.[n2RunLabel], uid: system.metadata.uid, caHash: sha256(Buffer.from(current.clusters[0].cluster['certificate-authority-data'], 'base64')) };
  }
  async assertIdentity() {
    try {
      if (this.refused) this.refuse('previous ownership refusal');
      const state = this.load();
      await this.daemon();
      const identity = await this.identity();
      if (identity.uid !== state.uid || identity.caHash !== state.caHash || identity.marker !== state.runId) this.refuse('cluster UID or CA differs from creation');
      const ids = (await this.execute('docker', ['ps', '-aq', '--filter', `label=io.x-k8s.kind.cluster=${this.cluster}`])).stdout.trim().split(/\s+/).filter(Boolean);
      const nodes = ids.length ? JSON.parse((await this.execute('docker', ['inspect', ...ids])).stdout) : [];
      if (!nodes.length || nodes.length !== state.nodes.length || nodes.some(n => !state.nodes.some(o => o.id === n.Id)
        || n.Config?.Labels?.['io.x-k8s.kind.cluster'] !== this.cluster)) this.refuse('kind node IDs differ from creation');
      for (const node of nodes) {
        const receipt = state.nodes.find(n => n.id === node.Id);
        if (JSON.stringify((node.Mounts ?? []).map(m => [m.Type, m.Name, m.Source, m.Destination])) !== JSON.stringify(receipt.mounts)) this.refuse('kind node mounts changed');
      }
      for (const [name, volume] of Object.entries(state.volumes)) {
        const actual = JSON.parse((await this.execute('docker', ['volume', 'inspect', name])).stdout)[0];
        if (JSON.stringify(actual) !== JSON.stringify(volume)) this.refuse('node volume identity changed');
      }
      return state;
    } catch (error) { this.refuse(error.message?.startsWith('N2 lab refused') ? 'identity or ownership mismatch' : 'identity proof unavailable'); }
  }
  async createCluster(config) {
    try {
      const path = this.pathProof(true);
      const runId = this.env.LAB_RUN_ID ?? `n2-${randomUUID()}`;
      if (!/^[a-z0-9-]{12,63}$/.test(runId)) this.refuse('invalid LAB_RUN_ID');
      await this.daemon();
      const clusters = (await this.execute('kind', ['get', 'clusters'])).stdout.trim().split(/\s+/);
      const ids = (await this.execute('docker', ['ps', '-aq', '--filter', `label=io.x-k8s.kind.cluster=${this.cluster}`])).stdout.trim();
      if (clusters.includes(this.cluster) || ids) this.refuse('preexisting cluster or kind nodes');
      const oldVolumes = new Set((await this.execute('docker', ['volume', 'ls', '-q'])).stdout.trim().split(/\s+/));
      const state = { phase: 'creating', runId, cluster: this.cluster, context: this.context, kubeconfig: path, resources: {}, containers: {}, images: {} };
      writeFileSync(this.statePath, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
      writeFileSync(this.kubeconfig, '', { flag: 'wx', mode: 0o600 });
      await this.execute('kind', ['create', 'cluster', '--name', this.cluster, '--kubeconfig', this.kubeconfig, '--wait', '0s', '--config', '-'], { input: config });
      const identity = await this.identity();
      const nodeIds = (await this.execute('docker', ['ps', '-aq', '--filter', `label=io.x-k8s.kind.cluster=${this.cluster}`])).stdout.trim().split(/\s+/).filter(Boolean);
      if (!nodeIds.length) this.refuse('no newly created kind nodes');
      const nodes = JSON.parse((await this.execute('docker', ['inspect', ...nodeIds])).stdout);
      state.nodes = nodes.map(n => ({ id: n.Id, mounts: (n.Mounts ?? []).map(m => [m.Type, m.Name, m.Source, m.Destination]) }));
      if (nodes.some(n => (n.Mounts ?? []).some(m => m.Type === 'volume' && oldVolumes.has(m.Name)))) this.refuse('node mounted a preexisting volume');
      state.volumes = {};
      for (const name of nodes.flatMap(n => (n.Mounts ?? []).filter(m => m.Type === 'volume').map(m => m.Name))) {
        state.volumes[name] = JSON.parse((await this.execute('docker', ['volume', 'inspect', name])).stdout)[0];
      }
      const kc = statSync(this.kubeconfig);
      Object.assign(state, identity, { phase: 'ready', kubeconfigInode: `${kc.dev}:${kc.ino}`, kubeconfigHash: sha256(readFileSync(this.kubeconfig)) });
      state.baselineNamespaces = Object.fromEntries(((await this.get('namespace')).items).map(n => [n.metadata.name, n.metadata.uid]));
      state.system = {};
      for (const [type, name] of [['configmap', 'coredns'], ['deployment', 'coredns']]) {
        const o = await this.get(type, name, 'kube-system');
        if (!o?.metadata?.uid) this.refuse('CoreDNS identity missing');
        state.system[`${type}/${name}`] = o.metadata.uid;
      }
      this.save(state);
      const beforeMark = await this.identity();
      if (beforeMark.uid !== state.uid || beforeMark.caHash !== state.caHash) this.refuse('identity changed before marking');
      await this.rawK(['label', 'namespace', 'kube-system', `${n2LabLabel}=n2`, `${n2RunLabel}=${runId}`]);
      await this.assertIdentity();
      return state;
    } catch (error) { this.refuse(`cluster creation incomplete or refused (${error.code ?? 'ownership'}); no automatic deletion`); }
  }
  owns(o, state) {
    return o?.metadata?.uid && o.metadata.labels?.[n2RunLabel] === state.runId && o.metadata.labels?.[n2LabLabel] === 'n2';
  }
  async ownedNamespace(name, state) {
    const ns = await this.get('namespace', name);
    if (!this.owns(ns, state) || state.resources[resourceKey(ns)] !== ns.metadata.uid) this.refuse('namespace ownership missing');
    return ns;
  }
  decorate(o, state) {
    o.metadata ??= {};
    o.metadata.labels = { ...o.metadata.labels, [n2LabLabel]: 'n2', [n2RunLabel]: state.runId };
    o.metadata.annotations = { ...o.metadata.annotations, 'gromesh.io/n2-cluster-uid': state.uid };
    for (const meta of [o.spec?.template?.metadata, o.spec?.jobTemplate?.spec?.template?.metadata]) {
      if (meta) meta.labels = { ...meta.labels, [n2LabLabel]: 'n2', [n2RunLabel]: state.runId };
    }
    return o;
  }
  async pvcs(namespace, state) {
    const list = await this.rawK(['get', 'pvc', ...(namespace ? ['-n', namespace] : ['-A']), '-o', 'json']);
    for (const pvc of JSON.parse(list.stdout).items) {
      if (!this.owns(pvc, state) || state.resources[resourceKey(pvc)] !== pvc.metadata.uid) this.refuse('foreign or preexisting PVC');
    }
  }
  async createdObject(o, state, depth = 0) {
    if (!this.owns(o, state)) return false;
    const receipt = state.resources[resourceKey(o)];
    if (receipt) return receipt === o.metadata.uid;
    // Controllers inherit the lab's pod-template labels. Their descendants are owned only through a
    // UID chain ending in a workload whose creation this run recorded, never through a copied label alone.
    if (depth >= 4 || !o.metadata.namespace || o.kind === 'PersistentVolumeClaim') return false;
    for (const ref of o.metadata.ownerReferences ?? []) {
      const parent = await this.get(ref.kind, ref.name, o.metadata.namespace);
      if (parent?.metadata?.uid === ref.uid && await this.createdObject(parent, state, depth + 1)) return true;
    }
    return false;
  }
  async checkObject(o, state) {
    if (o.kind.toLowerCase() === 'namespace') {
      if (!this.owns(o, state) || state.resources[resourceKey(o)] !== o.metadata.uid) this.refuse('namespace is not owned by this execution');
      await this.pvcs(o.metadata.name, state);
    } else if (o.metadata.namespace === 'kube-system') {
      if (state.system[`${o.kind.toLowerCase()}/${o.metadata.name}`] !== o.metadata.uid) this.refuse('system object is not the recorded CoreDNS object');
    } else {
      if (o.metadata.namespace) await this.ownedNamespace(o.metadata.namespace, state);
      if (!await this.createdObject(o, state)) this.refuse('resource lacks creation ownership');
      if (o.kind.toLowerCase() === 'persistentvolumeclaim' && state.resources[resourceKey(o)] !== o.metadata.uid) this.refuse('preexisting PVC');
    }
  }
  serialized(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  kubectl(args, options = {}) {
    return this.serialized(async () => {
      try { return await this.kubeOperation(args, options); }
      catch (error) {
        if (error.message?.startsWith('N2 lab refused')) throw error;
        this.refuse('resource ownership inspection or mutation failed');
      }
    });
  }
  async kubeOperation(args, options) {
    const state = await this.assertIdentity();
    const verbs = ['get', 'logs', 'wait', 'version', 'rollout', 'exec', 'apply', 'create', 'delete', 'run', 'set', 'patch', 'scale', 'port-forward'];
    const verb = args.find(a => verbs.includes(a));
    if (!verb) this.refuse('unknown kubectl operation');
    if (['get', 'logs', 'wait', 'version', 'port-forward'].includes(verb) || (verb === 'rollout' && args.includes('status'))
      || args.includes('--dry-run=client')) return this.rawK(args, options);
    const namespace = flagValue(args, '-n', '--namespace');
    if (['apply', 'create'].includes(verb)) {
      if (!args.includes('-f') || flagValue(args, '-f') !== '-') this.refuse('manifests must go through guarded stdin');
      let parsed;
      try { parsed = JSON.parse(options.input); }
      catch { parsed = JSON.parse((await this.rawK(['create', '--dry-run=client', '-f', '-', '-o', 'json'], options)).stdout); }
      const objects = parsed.kind === 'List' ? parsed.items : [parsed];
      // Preflight the whole batch before the first write.
      for (const o of objects) {
        if (namespace) o.metadata.namespace ??= namespace;
        const existing = await this.get(o.kind, o.metadata.name, o.metadata.namespace);
        if (existing) await this.checkObject(existing, state);
        else if (o.metadata.namespace && !objects.some(n => n.kind === 'Namespace' && n.metadata.name === o.metadata.namespace)) await this.ownedNamespace(o.metadata.namespace, state);
      }
      let result;
      for (const o of objects) {
        const existing = await this.get(o.kind, o.metadata.name, o.metadata.namespace);
        if (existing) {
          await this.checkObject(existing, state);
          o.metadata.uid = existing.metadata.uid;
          o.metadata.resourceVersion = existing.metadata.resourceVersion;
        }
        await this.assertIdentity();
        result = await this.rawK([existing ? 'apply' : 'create', '-f', '-', '-o', 'json'], { ...options, input: JSON.stringify(this.decorate(o, state)), allowFail: false });
        const actual = JSON.parse(result.stdout);
        if (!actual.metadata?.uid) this.refuse('created resource has no UID receipt');
        state.resources[resourceKey(actual)] = actual.metadata.uid;
        this.save(state);
      }
      return result;
    }
    if (verb === 'run') {
      await this.ownedNamespace(namespace, state);
      const labels = `${n2LabLabel}=n2,${n2RunLabel}=${state.runId}`;
      const boundary = args.indexOf('--');
      const labelled = [...args]; labelled.splice(boundary < 0 ? args.length : boundary, 0, `--labels=${labels}`);
      labelled.splice(labelled.indexOf('--') < 0 ? labelled.length : labelled.indexOf('--'), 0, '-o', 'json');
      const result = await this.rawK(labelled, { ...options, allowFail: false });
      const actual = JSON.parse(result.stdout);
      if (!this.owns(actual, state)) this.refuse('created pod has no ownership receipt');
      state.resources[resourceKey(actual)] = actual.metadata.uid; this.save(state);
      return result;
    }
    if (verb === 'delete') {
      const at = args.indexOf('delete'), type = args[at + 1];
      const tail = args.slice(at + 2);
      const names = [];
      for (let i = 0; i < tail.length; i++) {
        if (['-n', '--namespace', '-l', '--selector', '--timeout'].includes(tail[i])) { i++; continue; }
        if (!tail[i].startsWith('-')) names.push(tail[i]);
      }
      const selected = flagValue(args, '-l', '--selector');
      let objects;
      if (selected || args.includes('--all')) {
        if (!namespace) this.refuse('unscoped collection delete');
        await this.ownedNamespace(namespace, state);
        objects = JSON.parse((await this.rawK(['get', type, '-n', namespace, ...(selected ? ['-l', selected] : []), '-o', 'json'])).stdout).items;
      } else objects = (await Promise.all(names.map(name => this.get(type, name, namespace)))).filter(Boolean);
      for (const o of objects) await this.checkObject(o, state);
      // Every target is proved before any target is removed. No broad selector is forwarded to deletion.
      for (const o of objects) {
        await this.assertIdentity();
        const plural = { Namespace: 'namespaces', PersistentVolumeClaim: 'persistentvolumeclaims', Pod: 'pods',
          ConfigMap: 'configmaps', Secret: 'secrets', Deployment: 'deployments', Job: 'jobs', Service: 'services', NetworkPolicy: 'networkpolicies',
          CiliumNetworkPolicy: 'ciliumnetworkpolicies', CiliumClusterwideNetworkPolicy: 'ciliumclusterwidenetworkpolicies' }[o.kind];
        if (!plural || !o.apiVersion) this.refuse('unknown delete resource path');
        const api = o.apiVersion === 'v1' ? '/api/v1' : `/apis/${o.apiVersion}`;
        const path = `${api}${o.metadata.namespace ? `/namespaces/${encodeURIComponent(o.metadata.namespace)}` : ''}/${plural}/${encodeURIComponent(o.metadata.name)}`;
        const grace = flagValue(args, '--grace-period');
        await this.rawK(['delete', '--raw', path, '-f', '-'], { ...options, allowFail: false,
          input: JSON.stringify({ apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: o.metadata.uid },
            ...(grace !== undefined ? { gracePeriodSeconds: Number(grace) } : {}) }) });
        if (!args.includes('--wait=false')) await this.rawK(['wait', '--for=delete', `${o.kind}/${o.metadata.name}`,
          ...(o.metadata.namespace ? ['-n', o.metadata.namespace] : []), `--timeout=${flagValue(args, '--timeout') ?? '240s'}`], options);
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    if (!namespace) this.refuse('unscoped mutation');
    if (namespace === 'kube-system') {
      if (verb !== 'rollout' || !args.includes('deployment/coredns')) this.refuse('unproven system mutation');
      await this.checkObject(await this.get('deployment', 'coredns', namespace), state);
    } else await this.ownedNamespace(namespace, state);
    const resource = args.find(a => /^(pod|deploy|deployment)\//.test(a));
    if (resource) {
      const [type, name] = resource.split('/');
      const o = await this.get(type, name, namespace);
      if (!o) this.refuse('mutation target missing');
      await this.checkObject(o, state);
    } else if (verb === 'exec') {
      const at = args.indexOf('exec');
      const targetArgs = args.slice(at + 1, args.indexOf('--'));
      const name = targetArgs.find((a, i) => !a.startsWith('-') && !['-n', '--namespace', '-c', '--container'].includes(targetArgs[i - 1]));
      const o = await this.get('pod', name, namespace);
      if (!o) this.refuse('exec pod missing');
      await this.checkObject(o, state);
    }
    return this.rawK(args, options);
  }
  async docker(args, options = {}) {
    const state = await this.assertIdentity();
    if (['inspect', 'logs', 'stats', 'network', 'image', 'ps'].includes(args[0])) {
      if (args[0] === 'image' && args[1] !== 'inspect') this.refuse('unguarded image mutation');
      if (args[0] === 'network' && args[1] !== 'inspect') this.refuse('network mutation');
      return this.execute('docker', args, options);
    }
    if (args[0] === 'run') {
      const name = flagValue(args, '--name');
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-v' && !args[i + 1]?.endsWith(':ro')) this.refuse('fixture mounts must be read-only');
        if (['--mount', '--volumes-from', '--privileged'].includes(args[i])) this.refuse('unproved fixture mount or privilege');
      }
      if (!name?.startsWith(`${this.cluster}-fx-`)) this.refuse('fixture name required');
      const all = (await this.execute('docker', ['ps', '-aq'])).stdout.trim().split(/\s+/).filter(Boolean);
      if (all.length) {
        const containers = JSON.parse((await this.execute('docker', ['inspect', ...all])).stdout);
        if (containers.some(c => c.Name === `/${name}`)) this.refuse('preexisting fixture container');
      }
      // Fixtures only bind the source read-only; images with implicit VOLUME would create unowned storage.
      const image = args.find(a => a.includes('@sha256:'));
      await this.pullImage(image);
      const info = JSON.parse((await this.execute('docker', ['image', 'inspect', image])).stdout)[0];
      if (Object.keys(info.Config?.Volumes ?? {}).length) this.refuse('fixture image declares implicit volumes');
      const result = await this.execute('docker', ['run', '--label', `${n2LabLabel}=n2`, '--label', `${n2RunLabel}=${state.runId}`, ...args.slice(1)], options);
      const c = JSON.parse((await this.execute('docker', ['inspect', name])).stdout)[0];
      if (c.Config?.Labels?.[n2RunLabel] !== state.runId || c.Config?.Labels?.[n2LabLabel] !== 'n2') this.refuse('fixture creation label missing');
      state.containers[name] = c.Id; this.save(state);
      return result;
    }
    if (args[0] === 'rm') {
      const name = args.at(-1);
      const ids = (await this.execute('docker', ['ps', '-aq', '--filter', `name=^/${name}$`])).stdout.trim().split(/\s+/).filter(Boolean);
      if (!ids.length) return { code: 0, stdout: '', stderr: '' };
      const c = JSON.parse((await this.execute('docker', ['inspect', ...ids])).stdout)[0];
      if (c.Id !== state.containers[name] || c.Config?.Labels?.[n2RunLabel] !== state.runId || c.Config?.Labels?.[n2LabLabel] !== 'n2') this.refuse('fixture container is not owned');
      return this.execute('docker', ['rm', '-f', c.Id], { ...options, allowFail: false });
    }
    if (args[0] === 'exec') {
      const target = args.slice(1).find(a => !a.startsWith('-'));
      const c = JSON.parse((await this.execute('docker', ['inspect', target])).stdout)[0];
      if (!state.nodes.some(n => n.id === c.Id) && !(state.containers[target] === c.Id && c.Config?.Labels?.[n2RunLabel] === state.runId)) this.refuse('docker exec target not owned');
      return this.execute('docker', args, options);
    }
    this.refuse('unsupported Docker mutation');
  }
  async helm(args, options = {}) {
    let state = await this.assertIdentity();
    const helm = (argv, opts = options) => this.execute('helm', ['--kubeconfig', this.kubeconfig, '--kube-context', this.context, ...argv], opts);
    if (['template', 'list', 'status', 'pull'].includes(args[0])) return helm(args);
    if (!['install', 'upgrade'].includes(args[0])) this.refuse('unsupported Helm mutation');
    const ns = flagValue(args, '-n', '--namespace');
    await this.ownedNamespace(ns, state);
    await this.pvcs(ns, state);
    const release = args.slice(1).find(a => !a.startsWith('-'));
    const releaseSecrets = async () => JSON.parse((await this.rawK(['get', 'secret', '-n', ns, '-l', `owner=helm,name=${release}`, '-o', 'json'])).stdout).items;
    for (const secret of await releaseSecrets()) {
      if (!this.owns(secret, state) || state.resources[resourceKey(secret)] !== secret.metadata.uid) this.refuse('preexisting Helm release');
    }
    for (const o of state.releases?.[`${ns}/${release}`] ?? []) {
      const existing = await this.get(o.kind, o.metadata.name, o.metadata.namespace);
      if (existing) await this.checkObject(existing, state);
    }
    // Helm does not post-render hooks. Render once up front to prove collisions for the entire chart,
    // then execute its schema Job through the same UID/ownership guard; Helm must never delete hooks by name.
    const rendered = await helm(['template', ...args.slice(1).filter(a => a !== '--install'), ...(args[0] === 'upgrade' ? ['--is-upgrade'] : [])]);
    const objects = await this.helmObjects(rendered.stdout, ns, state);
    const hooks = objects.filter(o => o.metadata.annotations?.['helm.sh/hook']);
    for (const hook of hooks) {
      if (hook.kind !== 'Job' || !/^(pre-install|pre-upgrade)(,pre-upgrade)?$/.test(hook.metadata.annotations['helm.sh/hook'])) this.refuse('unsupported Helm hook');
    }
    for (const hook of hooks) {
      await this.kubectl(['delete', 'job', hook.metadata.name, '-n', ns, '--ignore-not-found']);
      delete hook.metadata.annotations['helm.sh/hook'];
      delete hook.metadata.annotations['helm.sh/hook-delete-policy'];
      delete hook.metadata.annotations['helm.sh/hook-weight'];
      await this.kubectl(['create', '-f', '-'], { input: JSON.stringify(hook) });
      await this.kubectl(['wait', '-n', ns, '--for=condition=complete', `job/${hook.metadata.name}`, '--timeout=90s']);
      await this.kubectl(['delete', 'job', hook.metadata.name, '-n', ns]);
    }
    await this.assertIdentity();
    const result = await helm([...args, '--no-hooks', '--post-renderer', process.execPath, '--post-renderer-args', resolve(import.meta.dirname, 'kind-stack-guard.mjs'), '--post-renderer-args', 'n2-helm-render'],
      { ...options, allowFail: false, env: { LAB_HELM_NAMESPACE: ns } });
    state = this.load();
    state.releases ??= {};
    state.releases[`${ns}/${release}`] = objects.filter(o => !hooks.includes(o)).map(o => ({ kind: o.kind, metadata: { name: o.metadata.name, namespace: ns } }));
    for (const secret of await releaseSecrets()) {
      await this.assertIdentity();
      await this.rawK(['label', 'secret', secret.metadata.name, '-n', ns, `${n2LabLabel}=n2`, `${n2RunLabel}=${state.runId}`,
        `--resource-version=${secret.metadata.resourceVersion}`, '--overwrite']);
      state.resources[resourceKey(secret)] = secret.metadata.uid;
    }
    for (const o of objects.filter(o => !hooks.includes(o))) {
      const actual = await this.get(o.kind, o.metadata.name, ns);
      if (!this.owns(actual, state)) this.refuse('Helm resource receipt unavailable');
      state.resources[resourceKey(actual)] = actual.metadata.uid;
    }
    this.save(state);
    return result;
  }
  async helmObjects(input, namespace, state = undefined) {
    state ??= await this.assertIdentity();
    await this.ownedNamespace(namespace, state);
    const parsed = JSON.parse((await this.rawK(['create', '--dry-run=client', '-f', '-', '-o', 'json'], { input })).stdout);
    const objects = parsed.kind === 'List' ? parsed.items : [parsed];
    for (const o of objects) {
      o.metadata.namespace ??= namespace;
      if (o.metadata.namespace !== namespace) this.refuse('Helm object outside owned namespace');
      const existing = await this.get(o.kind, o.metadata.name, namespace);
      if (existing) await this.checkObject(existing, state);
      this.decorate(o, state);
    }
    return objects;
  }
  async image(args) {
    const state = await this.assertIdentity();
    const verb = args[0];
    if (verb === 'clean') {
      // All aliases are checked before removing the first one; never remove by image ID or use --force.
      const present = new Set((await this.execute('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'])).stdout.trim().split(/\s+/));
      const aliases = Object.entries(state.images).filter(([tag]) => present.has(tag));
      for (const [tag, receipt] of aliases) {
        const image = JSON.parse((await this.execute('docker', ['image', 'inspect', tag])).stdout)[0];
        if (image.Id !== receipt.id || (receipt.built && (image.Config?.Labels?.[n2RunLabel] !== state.runId
          || image.Config?.Labels?.[n2LabLabel] !== 'n2'))) this.refuse('image alias ownership differs');
      }
      const deleting = new Set(aliases.map(([tag]) => tag));
      for (const [tag, receipt] of aliases) {
        await this.assertIdentity();
        const image = JSON.parse((await this.execute('docker', ['image', 'inspect', tag])).stdout)[0];
        if (image.Id !== receipt.id) this.refuse('image alias changed during cleanup');
        // Removing the last tag may delete the image AND its RepoDigests. A digest reference alone
        // cannot protect a borrowed image: retain our alias unless another durable tag will remain.
        if (!receipt.built && !(image.RepoTags ?? []).some(t => t !== tag && !deleting.has(t))) continue;
        await this.execute('docker', ['image', 'rm', tag]);
      }
      return;
    }
    if (!['build', 'tag'].includes(verb)) this.refuse('unsupported image operation');
    const tag = verb === 'tag' ? args[2] : flagValue(args, '-t', '--tag');
    if (!tag?.includes(state.runId)) this.refuse('image tag must include this execution ID');
    const present = (await this.execute('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'])).stdout.trim().split(/\s+/);
    if (present.includes(tag)) this.refuse('preexisting image tag');
    const result = await this.execute('docker', verb === 'tag' ? args : ['build', '--label', `${n2LabLabel}=n2`, '--label', `${n2RunLabel}=${state.runId}`, ...args.slice(1)]);
    const image = JSON.parse((await this.execute('docker', ['image', 'inspect', tag])).stdout)[0];
    if (!image?.Id) this.refuse('created image has no ID');
    state.images[tag] = { id: image.Id, built: verb === 'build' }; this.save(state);
    return result;
  }
  async pullImage(image) {
    await this.assertIdentity();
    if (!/@sha256:[0-9a-f]{64}$/.test(image)) this.refuse('pull requires a pinned digest');
    return this.execute('docker', ['pull', '-q', image]);
  }
  async loadImage(image) {
    const state = await this.assertIdentity();
    const current = JSON.parse((await this.execute('docker', ['image', 'inspect', image])).stdout)[0];
    if (!state.images[image]?.id || state.images[image].id !== current.Id) this.refuse('image not created by this execution');
    return this.execute('kind', ['load', 'docker-image', '--name', this.cluster, image]);
  }
  async preflightResources(resources, required = false) {
    const state = await this.assertIdentity();
    for (const { type, name, namespace } of resources) {
      const o = await this.get(type, name, namespace);
      if (!o && required) this.refuse('required mutation target missing');
      if (o) await this.checkObject(o, state);
    }
  }
  async preflightDestroyCluster() {
    const state = await this.assertIdentity();
    const namespaces = (await this.get('namespace')).items;
    for (const ns of namespaces) {
      if (state.baselineNamespaces[ns.metadata.name] === ns.metadata.uid) continue;
      await this.checkObject(ns, state);
    }
    await this.pvcs(undefined, state);
    // kind deletes its node volumes too: the exact node IDs and unchanged mount inventory were checked above.
    for (const [name, id] of Object.entries(state.containers)) {
      const ids = (await this.execute('docker', ['ps', '-aq', '--filter', `name=^/${name}$`])).stdout.trim();
      if (!ids) continue;
      const c = JSON.parse((await this.execute('docker', ['inspect', ids])).stdout)[0];
      if (c.Id !== id || c.Config?.Labels?.[n2RunLabel] !== state.runId || c.Config?.Labels?.[n2LabLabel] !== 'n2') this.refuse('fixture container ownership differs');
    }
    return state;
  }
  async destroyCluster() {
    const state = await this.preflightDestroyCluster();
    for (const name of Object.keys(state.containers)) await this.docker(['rm', '-f', name]);
    await this.assertIdentity();
    return this.execute('kind', ['delete', 'cluster', '--name', this.cluster, '--kubeconfig', this.kubeconfig]);
  }
}

async function n2Command([command, ...args]) {
  const lab = new N2Lab();
  if (command === 'n2-create') await lab.createCluster(readFileSync(0, 'utf8'));
  else if (command === 'n2-assert') await lab.assertIdentity();
  else if (command === 'n2-down') await lab.destroyCluster();
  else if (command === 'n2-image') await lab.image(args);
  else if (command === 'n2-load') await lab.loadImage(args[0]);
  else if (command === 'n2-pull') await lab.pullImage(args[0]);
  else if (command === 'n2-preflight-down') await lab.preflightDestroyCluster();
  else if (command === 'n2-helm-render') {
    const objects = await lab.helmObjects(readFileSync(0, 'utf8'), process.env.LAB_HELM_NAMESPACE);
    console.log(JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objects }));
  } else throw n2Refused('unknown guard command');
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href)
  if (process.argv[2]?.startsWith("n2-")) await n2Command(process.argv.slice(2));
  else if (process.argv[2] === "name") {
    if (!/^[a-zA-Z0-9_-]{12,128}$/.test(process.env.GROMESH_DISPOSABLE_ID ?? "")) throw fail();
    console.log(kindClusterName(process.env.GROMESH_DISPOSABLE_ID));
  } else await assertKindStack(process.argv[2]);
