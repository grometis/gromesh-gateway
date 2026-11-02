import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { assertLocalDaemon, daemonProblems } from "./stack-guard.mjs";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, readlinkSync, existsSync, lstatSync, statSync, realpathSync, renameSync, mkdirSync } from "node:fs";
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
  constructor({ env = process.env, execute = n2Execute, spawnProcess = spawn } = {}) {
    this.spawnProcess = spawnProcess;
    this.env = { ...env, KUBECONFIG: env.LAB_KUBECONFIG };
    this.execute = (command, args, options = {}) => execute(command, args, { ...options, env: { ...this.env, ...options.env } });
    this.cluster = 'gromesh-n2-lab';
    this.context = `kind-${this.cluster}`;
    this.kubeconfig = env.LAB_KUBECONFIG;
    this.statePath = `${this.kubeconfig}.n2-owner.json`;
    this.refusalPath = `${this.statePath}.refused`;
    this.explicitEvidence = env.LAB_EVIDENCE_DIR ?? env.OUT ?? env.LAB_OUT;
    this.evidenceDir = this.explicitEvidence ?? (this.kubeconfig ? dirname(resolve(this.kubeconfig)) : undefined);
    this.refused = false;
    this.queue = Promise.resolve();
  }
  refuse(reason) {
    this.refused = true;
    // The sibling latch survives a new process with a different LAB_OUT. The evidence copy is for the run.
    if (this.kubeconfig) {
      const evidenceDirs = new Set([this.validatedPath || this.explicitEvidence ? this.evidenceDir : undefined]);
      try { evidenceDirs.add(JSON.parse(readFileSync(this.statePath, 'utf8')).evidenceDir); } catch { /* no creation receipt yet */ }
      evidenceDirs.delete(undefined);
      const marker = JSON.stringify({ reason, runId: this.env.LAB_RUN_ID, evidenceDirs: [...evidenceDirs] });
      for (const file of [...(this.validatedPath ? [this.refusalPath] : []), ...[...evidenceDirs].map(dir => join(dir, 'n2-refused.json'))]) {
        try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, marker, { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (error.code !== 'EEXIST') reason = `${reason}; refusal marker unavailable (${error.code})`; }
      }
    }
    throw n2Refused(reason);
  }
  assertNotRefused() {
    if (this.refused || existsSync(this.refusalPath) || (this.evidenceDir && existsSync(join(this.evidenceDir, 'n2-refused.json'))))
      this.refuse('previous persistent ownership refusal');
  }
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
    this.validatedPath = true;
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
      this.assertNotRefused();
      const state = this.load();
      if (state.evidenceDir && existsSync(join(state.evidenceDir, 'n2-refused.json'))) this.refuse('previous run refusal');
      await this.daemon();
      const identity = await this.identity();
      if (identity.uid !== state.uid || identity.caHash !== state.caHash || identity.marker !== state.runId) this.refuse('cluster UID or CA differs from creation');
      const ids = (await this.execute('docker', ['ps', '-aq', '--filter', `label=io.x-k8s.kind.cluster=${this.cluster}`])).stdout.trim().split(/\s+/).filter(Boolean);
      const nodes = ids.length ? JSON.parse((await this.execute('docker', ['inspect', ...ids])).stdout) : [];
      if (!nodes.length || nodes.length !== state.nodes.length || nodes.some(n => !state.nodes.some(o => o.id === n.Id)
        || n.Config?.Labels?.['io.x-k8s.kind.cluster'] !== this.cluster)) this.refuse('kind node IDs differ from creation');
      for (const node of nodes) {
        const receipt = state.nodes.find(n => n.id === node.Id);
        await this.proveNode(receipt.nodeName, state);
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
      this.assertNotRefused();
      const path = this.pathProof(true);
      const runId = this.env.LAB_RUN_ID ?? `n2-${randomUUID()}`;
      if (!/^[a-z0-9-]{12,63}$/.test(runId)) this.refuse('invalid LAB_RUN_ID');
      await this.daemon();
      const clusters = (await this.execute('kind', ['get', 'clusters'])).stdout.trim().split(/\s+/);
      const ids = (await this.execute('docker', ['ps', '-aq', '--filter', `label=io.x-k8s.kind.cluster=${this.cluster}`])).stdout.trim();
      if (clusters.includes(this.cluster) || ids) this.refuse('preexisting cluster or kind nodes');
      const oldVolumes = new Set((await this.execute('docker', ['volume', 'ls', '-q'])).stdout.trim().split(/\s+/));
      const state = { phase: 'creating', runId, cluster: this.cluster, context: this.context, kubeconfig: path, evidenceDir: this.evidenceDir, resources: {}, containers: {}, images: {} };
      writeFileSync(this.statePath, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
      writeFileSync(this.kubeconfig, '', { flag: 'wx', mode: 0o600 });
      await this.execute('kind', ['create', 'cluster', '--name', this.cluster, '--kubeconfig', this.kubeconfig, '--wait', '0s', '--config', '-'], { input: config });
      const identity = await this.identity();
      const nodeIds = (await this.execute('docker', ['ps', '-aq', '--filter', `label=io.x-k8s.kind.cluster=${this.cluster}`])).stdout.trim().split(/\s+/).filter(Boolean);
      if (!nodeIds.length) this.refuse('no newly created kind nodes');
      const nodes = JSON.parse((await this.execute('docker', ['inspect', ...nodeIds])).stdout);
      state.nodes = [];
      for (const n of nodes) {
        const name = n.Name?.replace(/^\//, '');
        const kn = await this.get('node', name);
        if (!kn?.metadata?.uid || kn.metadata.name !== name || kn.metadata.labels?.['kubernetes.io/hostname'] !== name
          || kn.spec?.providerID !== `kind://docker/${this.cluster}/${name}` || n.Config?.Hostname !== name
          || n.Config?.Labels?.['io.x-k8s.kind.cluster'] !== this.cluster)
          this.refuse('Docker node cannot be linked to a newly created Kubernetes Node');
        state.nodes.push({ id: n.Id, nodeName: name, nodeUid: kn.metadata.uid, nodeProviderId: kn.spec.providerID,
          mounts: (n.Mounts ?? []).map(m => [m.Type, m.Name, m.Source, m.Destination]) });
      }
      if (nodes.some(n => (n.Mounts ?? []).some(m => m.Type === 'volume' && oldVolumes.has(m.Name)))) this.refuse('node mounted a preexisting volume');
      state.volumes = {};
      for (const name of nodes.flatMap(n => (n.Mounts ?? []).filter(m => m.Type === 'volume').map(m => m.Name))) {
        state.volumes[name] = JSON.parse((await this.execute('docker', ['volume', 'inspect', name])).stdout)[0];
      }
      const kc = statSync(this.kubeconfig);
      Object.assign(state, identity, { phase: 'ready', kubeconfigInode: `${kc.dev}:${kc.ino}`, kubeconfigHash: sha256(readFileSync(this.kubeconfig)) });
      state.baselineClusterResources = Object.fromEntries((await this.clusterResources()).filter(o => this.knownClusterBaseline(o, state)).map(o => [resourceKey(o), this.baselineProof(o)]));
      const baseline = await this.namespacedResources();
      state.baselineNamespacedResources = Object.fromEntries(baseline.filter(o => this.knownSystemBaseline(o, state, baseline)).map(o => [resourceKey(o), this.baselineProof(o)]));
      state.baselineNamespaces = Object.fromEntries(((await this.get('namespace')).items)
        .filter(n => ['default', 'kube-system', 'kube-public', 'kube-node-lease'].includes(n.metadata.name)).map(n => [n.metadata.name, n.metadata.uid]));
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
    if (name === 'kube-system' && ns?.metadata?.uid === state.uid && ns.metadata.labels?.[n2RunLabel] === state.runId) return ns;
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
  async createdObject(o, state, depth = 0, seen = new Set()) {
    if (!o?.metadata?.uid || depth >= 8 || seen.has(o.metadata.uid) || o.metadata.finalizers?.length) return false;
    seen = new Set([...seen, o.metadata.uid]);
    const refs = o.metadata.ownerReferences ?? [];
    if (refs.filter(r => r.controller).length > 1) return false;
    if (o.kind === 'CiliumNode') {
      // Cilium creates these without our labels. Only the Node UID links the controller's result to this run.
      if (refs.length !== 1 || o.metadata.namespace) return false;
      const ref = refs[0], node = state.nodes.find(n => n.nodeUid === ref.uid && n.nodeName === ref.name);
      if (!node || ref.kind !== 'Node' || ref.apiVersion !== 'v1' || ref.controller !== true || o.metadata.name !== node.nodeName) return false;
      await this.proveNode(node.nodeName, state);
      return true;
    }
    if (!this.owns(o, state)) return false;
    const receipt = state.resources[resourceKey(o)];
    if (receipt && (receipt !== o.metadata.uid || JSON.stringify(refs) !== JSON.stringify(state.resourceOwners?.[resourceKey(o)] ?? []))) return false;
    if (!receipt && (!o.metadata.namespace || o.kind === 'PersistentVolumeClaim' || refs.length !== 1)) return false;
    if (!receipt && !({ Pod: ['ReplicaSet', 'Job', 'DaemonSet', 'StatefulSet'], ReplicaSet: ['Deployment'], Job: ['CronJob'] }[o.kind] ?? []).includes(refs[0]?.kind)) return false;
    if (!receipt && refs[0]?.controller !== true) return false;
    for (const ref of refs) {
      if (!ref.uid || !ref.apiVersion || !ref.kind || !ref.name) return false;
      const parent = await this.get(ref.kind, ref.name, o.metadata.namespace);
      if (parent?.metadata?.uid !== ref.uid || parent.apiVersion !== ref.apiVersion
        || !await this.createdObject(parent, state, depth + 1, seen)) return false;
    }
    return Boolean(receipt || refs.length);
  }
  async checkObject(o, state) {
    if (o.kind.toLowerCase() === 'namespace') {
      if (!this.owns(o, state) || state.resources[resourceKey(o)] !== o.metadata.uid) this.refuse('namespace is not owned by this execution');
      await this.pvcs(o.metadata.name, state);
      await this.checkInventory(state, o.metadata.name);
    } else if (o.metadata.namespace === 'kube-system') {
      if (state.system[`${o.kind.toLowerCase()}/${o.metadata.name}`] !== o.metadata.uid && !await this.createdObject(o, state)) this.refuse('system object is not the recorded CoreDNS object');
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
    const boundary = args.indexOf('--');
    const head = args.slice(0, boundary < 0 ? args.length : boundary);
    const verb = head.find((a, i) => verbs.includes(a) && !['-n', '--namespace', '-c', '--container', '-o', '--output'].includes(head[i - 1]));
    if (!verb) this.refuse('unknown kubectl operation');
    if (['get', 'logs', 'wait', 'version', 'port-forward'].includes(verb) || (verb === 'rollout' && args.includes('status'))
      || (['apply', 'create', 'run'].includes(verb) && head.includes('--dry-run=client'))) return this.rawK(args, options);
    const namespace = flagValue(args, '-n', '--namespace');
    if (verb === 'exec') return this.containerExecArgs(args, options);
    if (['apply', 'create'].includes(verb)) {
      if (!args.includes('-f') || flagValue(args, '-f') !== '-') this.refuse('manifests must go through guarded stdin');
      let parsed;
      try { parsed = JSON.parse(options.input); }
      catch { parsed = JSON.parse((await this.rawK(['create', '--dry-run=client', '-n', namespace ?? 'default', '-f', '-', '-o', 'json'], options)).stdout); }
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
        await this.assertIdentity();
        const existing = await this.get(o.kind, o.metadata.name, o.metadata.namespace);
        if (existing) {
          await this.checkObject(existing, state);
          o.metadata.uid = existing.metadata.uid;
          o.metadata.resourceVersion = existing.metadata.resourceVersion;
        }
        result = await this.rawK([existing ? 'apply' : 'create', '-f', '-', '-o', 'json'], { ...options, input: JSON.stringify(this.decorate(o, state)), allowFail: false });
        const actual = JSON.parse(result.stdout);
        if (!actual.metadata?.uid) this.refuse('created resource has no UID receipt');
        state.resources[resourceKey(actual)] = actual.metadata.uid;
        state.resourceOwners ??= {}; state.resourceOwners[resourceKey(actual)] = actual.metadata.ownerReferences ?? [];
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
      state.resources[resourceKey(actual)] = actual.metadata.uid;
      state.resourceOwners ??= {}; state.resourceOwners[resourceKey(actual)] = actual.metadata.ownerReferences ?? []; this.save(state);
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
      for (const o of objects) {
        await this.checkObject(o, state);
        await this.checkDeleteEffects(o, state);
      }
      this.requireDeleteFence(objects, state);
      // Every target is proved before any target is removed. No broad selector is forwarded to deletion.
      for (const o of objects) {
        await this.assertIdentity();
        const current = await this.get(o.kind, o.metadata.name, o.metadata.namespace);
        if (!current || current.metadata.uid !== o.metadata.uid) this.refuse('delete target changed');
        await this.checkObject(current, state);
        await this.checkDeleteEffects(current, state);
        const plural = { Namespace: 'namespaces', PersistentVolumeClaim: 'persistentvolumeclaims', Pod: 'pods',
          ConfigMap: 'configmaps', Secret: 'secrets', Deployment: 'deployments', Job: 'jobs', Service: 'services', NetworkPolicy: 'networkpolicies',
          CiliumNetworkPolicy: 'ciliumnetworkpolicies', CiliumClusterwideNetworkPolicy: 'ciliumclusterwidenetworkpolicies' }[o.kind];
        if (!plural || !o.apiVersion) this.refuse('unknown delete resource path');
        const api = o.apiVersion === 'v1' ? '/api/v1' : `/apis/${o.apiVersion}`;
        const path = `${api}${o.metadata.namespace ? `/namespaces/${encodeURIComponent(o.metadata.namespace)}` : ''}/${plural}/${encodeURIComponent(o.metadata.name)}`;
        const grace = flagValue(args, '--grace-period');
        await this.rawK(['delete', '--raw', path, '-f', '-'], { ...options, allowFail: false,
          input: JSON.stringify({ apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: 'Orphan', preconditions: { uid: o.metadata.uid, resourceVersion: current.metadata.resourceVersion },
            ...(grace !== undefined ? { gracePeriodSeconds: Number(grace) } : {}) }) });
        if (!args.includes('--wait=false')) await this.rawK(['wait', '--for=delete', `${o.kind}/${o.metadata.name}`,
          ...(o.metadata.namespace ? ['-n', o.metadata.namespace] : []), `--timeout=${flagValue(args, '--timeout') ?? '240s'}`], options);
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    if (!namespace) this.refuse('unscoped mutation');
    await this.ownedNamespace(namespace, state);
    const resource = args.find(a => /^(pod|deploy|deployment)\//.test(a));
    if (resource) {
      const [type, name] = resource.split('/');
      const o = await this.get(type, name, namespace);
      if (!o) this.refuse('mutation target missing');
      await this.checkObject(o, state);
    }
    await this.assertIdentity();
    await this.ownedNamespace(namespace, state);
    const type = resource?.split('/')[0] ?? 'pod';
    const at = args.indexOf(verb);
    const name = resource?.split('/')[1] ?? args.slice(at + 1, boundary < 0 ? args.length : boundary)
      .find((a, i, tail) => !a.startsWith('-') && !['-n', '--namespace', '-c', '--container'].includes(tail[i - 1]));
    const current = await this.get(type, name, namespace);
    if (!current) this.refuse('mutation target disappeared');
    await this.checkObject(current, state);
    if (verb === 'rollout' && args.includes('restart')) {
      const object = structuredClone(current);
      object.spec.template.metadata ??= {};
      object.spec.template.metadata.annotations = { ...object.spec.template.metadata.annotations, 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() };
      return this.rawK(['apply', '-f', '-', '-o', 'json'], { ...options, input: JSON.stringify(object), allowFail: false });
    }
    if (verb === 'set') {
      const generated = JSON.parse((await this.rawK([...args, '--dry-run=client', '-o', 'json'], options)).stdout);
      generated.metadata.uid = current.metadata.uid;
      generated.metadata.resourceVersion = current.metadata.resourceVersion;
      return this.rawK(['apply', '-f', '-', '-o', 'json'], { ...options, input: JSON.stringify(generated), allowFail: false });
    }
    if (verb === 'scale') return this.rawK([...args, `--resource-version=${current.metadata.resourceVersion}`], options);
    if (verb === 'patch') this.refuse('patch requires a guarded object manifest');
    return this.rawK(args, options);
  }
  async docker(args, options = {}) {
    try { return await this.dockerOperation(args, options); }
    catch (error) { this.refuse(error.message?.startsWith('N2 lab refused') ? 'Docker ownership refused' : 'Docker preflight or mutation failed'); }
  }
  async dockerOperation(args, options = {}) {
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
      const result = await this.execute('docker', ['run', '--label', `${n2LabLabel}=n2`, '--label', `${n2RunLabel}=${state.runId}`, ...args.slice(1).map(a => a === image ? info.Id : a)], options);
      const c = JSON.parse((await this.execute('docker', ['inspect', result.stdout.trim()])).stdout)[0];
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
      const receipt = state.containers[target];
      if (!receipt) this.refuse('node exec requires a bound container capability; arbitrary node commands are forbidden');
      const c = JSON.parse((await this.execute('docker', ['inspect', receipt])).stdout)[0];
      if (c?.Id !== receipt || c.Config?.Labels?.[n2RunLabel] !== state.runId || c.Config?.Labels?.[n2LabLabel] !== 'n2') this.refuse('fixture exec target changed');
      const pinned = [...args]; pinned[pinned.indexOf(target)] = receipt;
      return this.execute('docker', pinned, options);
    }
    this.refuse('unsupported Docker mutation');
  }
  async proveNode(name, state) {
    const receipt = state.nodes.find(n => n.nodeName === name);
    if (!receipt?.nodeUid || !receipt.id) this.refuse('node has no Docker/Kubernetes creation binding');
    const kn = await this.get('node', name);
    const c = JSON.parse((await this.execute('docker', ['inspect', receipt.id])).stdout)[0];
    if (kn?.metadata?.uid !== receipt.nodeUid || kn.metadata.name !== name
      || kn.metadata.labels?.['kubernetes.io/hostname'] !== name || kn.spec?.providerID !== receipt.nodeProviderId
      || receipt.nodeProviderId !== `kind://docker/${this.cluster}/${name}` || c?.Config?.Hostname !== name || c?.Id !== receipt.id
      || c.Name !== `/${name}` || c.State?.Running !== true || c.Config?.Labels?.['io.x-k8s.kind.cluster'] !== this.cluster)
      this.refuse('node binding changed');
    return receipt;
  }
  async containerTarget(namespace, podName, container) {
    const state = await this.assertIdentity();
    const ns = await this.ownedNamespace(namespace, state);
    const pod = await this.get('pod', podName, namespace);
    if (!pod || pod.kind !== 'Pod') this.refuse('exec requires an exact pod');
    await this.checkObject(pod, state);
    const statuses = [...(pod.status?.containerStatuses ?? []), ...(pod.status?.initContainerStatuses ?? [])];
    const selected = container ? statuses.filter(c => c.name === container) : statuses.filter(c => pod.spec?.containers?.some(s => s.name === c.name));
    if (selected.length !== 1 || !/^containerd:\/\/[a-f0-9]{64}$/.test(selected[0].containerID ?? '')) this.refuse('unambiguous container ID required');
    const node = await this.proveNode(pod.spec?.nodeName, state);
    return Object.freeze({ namespace, namespaceUid: ns.metadata.uid, podName, podUid: pod.metadata.uid,
      container: selected[0].name, containerID: selected[0].containerID.slice('containerd://'.length), node: node.nodeName, nodeUid: node.nodeUid, nodeID: node.id });
  }
  async validateContainer(target) {
    const actual = await this.containerTarget(target.namespace, target.podName, target.container);
    if (JSON.stringify(actual) !== JSON.stringify(target)) this.refuse('pod, namespace, node or container identity changed');
    return actual;
  }
  async inspectContainer(target) {
    await this.validateContainer(target);
    const result = await this.execute('docker', ['exec', target.nodeID, 'crictl', 'inspect', '--output', 'json', target.containerID]);
    const info = JSON.parse(result.stdout), status = info.status, labels = status?.labels;
    if (status?.id !== target.containerID || status.metadata?.name !== target.container
      || labels?.['io.kubernetes.pod.uid'] !== target.podUid || labels?.['io.kubernetes.pod.namespace'] !== target.namespace
      || labels?.['io.kubernetes.pod.name'] !== target.podName) this.refuse('CRI container does not belong to the proved pod');
    await this.validateContainer(target);
    return info;
  }
  async execContainer(target, command, options = {}) {
    try {
      if (!command.length) this.refuse('empty container command');
      await this.inspectContainer(target);
      const result = await this.execute('docker', ['exec', ...(options.input !== undefined ? ['-i'] : []), target.nodeID,
        'crictl', 'exec', ...(options.input !== undefined ? ['-i'] : []), target.containerID, ...command], options);
      // The result is not returned to callers when Kubernetes identity changes during the execution.
      await this.validateContainer(target);
      return result;
    } catch (error) { this.refuse(error.message?.startsWith('N2 lab refused') ? 'container identity changed' : 'container execution proof unavailable'); }
  }
  async containerExecArgs(args, options = {}) {
    const boundary = args.indexOf('--'), at = args.indexOf('exec');
    if (boundary < 0) this.refuse('exec command boundary required');
    const namespace = flagValue(args.slice(0, boundary), '-n', '--namespace');
    const tail = args.slice(at + 1, boundary);
    const resource = tail.find((a, i) => !a.startsWith('-') && !['-n', '--namespace', '-c', '--container'].includes(tail[i - 1]));
    let podName = resource?.replace(/^pods?\//, '');
    if (!namespace || !podName) this.refuse('explicit namespace and pod required');
    if (/^(deploy|deployment)\//.test(resource)) {
      const state = await this.assertIdentity();
      const workload = await this.get('deployment', resource.split('/')[1], namespace);
      if (!workload) this.refuse('exec workload missing');
      await this.checkObject(workload, state);
      const selector = workload.spec?.selector;
      if (!selector?.matchLabels || selector.matchExpressions?.length) this.refuse('unprovable exec workload selector');
      const pods = (await this.get('pod', undefined, namespace))?.items;
      const selected = pods?.filter(p => Object.entries(selector.matchLabels).every(([k, v]) => p.metadata.labels?.[k] === v));
      if (selected?.length !== 1 || !await this.descendsFrom(selected[0], workload, state)) this.refuse('exec workload must resolve to one proved descendant');
      podName = selected[0].metadata.name;
    } else if (podName.includes('/')) this.refuse('unsupported exec target');
    const target = await this.containerTarget(namespace, podName, flagValue(args.slice(0, boundary), '-c', '--container'));
    return this.execContainer(target, args.slice(boundary + 1), options);
  }
  async descendsFrom(object, ancestor, state, depth = 0) {
    if (depth >= 8 || !await this.createdObject(object, state)) return false;
    if (object.metadata.uid === ancestor.metadata.uid) return true;
    for (const ref of object.metadata.ownerReferences ?? []) {
      const parent = await this.get(ref.kind, ref.name, object.metadata.namespace);
      if (parent?.metadata?.uid === ref.uid && parent.apiVersion === ref.apiVersion && await this.descendsFrom(parent, ancestor, state, depth + 1)) return true;
    }
    return false;
  }
  async spawnContainer(target, command) {
    await this.inspectContainer(target);
    const child = this.spawnProcess('docker', ['exec', '-i', target.nodeID, 'crictl', 'exec', '-i', target.containerID, ...command],
      { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.verified = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => this.validateContainer(target).then(resolve, reject));
    });
    // Callers must await verified before using collected output; handle early failure until they do so.
    child.verified.catch(() => {});
    return child;
  }
  async nodeRead(name, command, options = {}) {
    const state = await this.assertIdentity();
    const allowed = (command[0] === 'cat' && command.length === 2 && ['/proc/loadavg', '/proc/uptime', '/proc/sys/kernel/random/boot_id'].includes(command[1]))
      || (command[0] === 'date' && command.length === 2 && ['+%s%3N', '+%s'].includes(command[1]))
      || (JSON.stringify(command.slice(0, 3)) === JSON.stringify(['ip', 'route', 'get']) && command.length === 4)
      || (JSON.stringify(command.slice(0, 4)) === JSON.stringify(['ip', '-6', 'route', 'get']) && command.length === 5)
      || (command[0] === 'crictl' && command[1] === 'inspecti' && command.length === 7 && command[2] === '-o' && command[3] === 'go-template' && command[4] === '--template');
    if (!allowed) this.refuse('unsupported node read; container capability required');
    const node = await this.proveNode(name, state);
    return this.execute('docker', ['exec', node.id, ...command], options);
  }
  async signalContainer(target, signal, comm) {
    if (!['STOP', 'CONT'].includes(signal) || !/^[a-zA-Z0-9_-]+$/.test(comm)) this.refuse('unsupported container signal');
    const info = await this.inspectContainer(target);
    const pid = info.info?.pid;
    if (!Number.isSafeInteger(pid) || pid <= 1) this.refuse('CRI process identity unavailable');
    const actual = await this.execute('docker', ['exec', target.nodeID, 'cat', `/proc/${pid}/comm`]);
    if (actual.stdout.trim() !== comm) this.refuse('CRI task process differs');
    await this.inspectContainer(target);
    // The runtime resolves the main task by its immutable container ID; never send kill to a reusable host PID.
    const result = await this.execute('docker', ['exec', target.nodeID, 'ctr', '--namespace=k8s.io', 'tasks', 'kill', '--signal', `SIG${signal}`, target.containerID]);
    await this.validateContainer(target);
    return { ...result, pid };
  }
  async helm(args, options = {}) {
    try { return await this.helmOperation(args, options); }
    catch (error) { this.refuse(error.message?.startsWith('N2 lab refused') ? 'Helm ownership refused' : 'Helm preflight or mutation failed'); }
  }
  async helmOperation(args, options = {}) {
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
    const rendered = await helm(['template', '--include-crds', ...args.slice(1).filter(a => a !== '--install'), ...(args[0] === 'upgrade' ? ['--is-upgrade'] : [])]);
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
    await this.helmObjects(rendered.stdout, ns);
    const crds = objects.filter(o => o.kind === 'CustomResourceDefinition');
    if (crds.length) await this.kubectl(['apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items: crds }) });
    const result = await helm([...args, '--skip-crds', '--no-hooks', '--post-renderer', process.execPath, '--post-renderer-args', resolve(import.meta.dirname, 'kind-stack-guard.mjs'), '--post-renderer-args', 'n2-helm-render'],
      { ...options, allowFail: false, env: { LAB_HELM_NAMESPACE: ns } });
    state = this.load();
    state.releases ??= {};
    state.releases[`${ns}/${release}`] = objects.filter(o => !hooks.includes(o)).map(o => ({ kind: o.kind, metadata: { name: o.metadata.name, namespace: o.metadata.namespace } }));
    for (const secret of await releaseSecrets()) {
      await this.assertIdentity();
      await this.rawK(['label', 'secret', secret.metadata.name, '-n', ns, `${n2LabLabel}=n2`, `${n2RunLabel}=${state.runId}`,
        `--resource-version=${secret.metadata.resourceVersion}`, '--overwrite']);
      state.resources[resourceKey(secret)] = secret.metadata.uid;
    }
    for (const o of objects.filter(o => !hooks.includes(o))) {
      const actual = await this.get(o.kind, o.metadata.name, o.metadata.namespace);
      if (!this.owns(actual, state)) this.refuse('Helm resource receipt unavailable');
      state.resources[resourceKey(actual)] = actual.metadata.uid;
      state.resourceOwners ??= {}; state.resourceOwners[resourceKey(actual)] = actual.metadata.ownerReferences ?? [];
    }
    this.save(state);
    return result;
  }
  async helmObjects(input, namespace, state = undefined) {
    try { return await this.renderHelmObjects(input, namespace, state); }
    catch (error) { this.refuse(error.message?.startsWith('N2 lab refused') ? 'Helm render ownership refused' : 'Helm manifest preflight failed'); }
  }
  async renderHelmObjects(input, namespace, state = undefined) {
    state ??= await this.assertIdentity();
    await this.ownedNamespace(namespace, state);
    const parsed = JSON.parse((await this.rawK(['create', '--dry-run=client', '-n', namespace, '-f', '-', '-o', 'json'], { input })).stdout);
    const objects = parsed.kind === 'List' ? parsed.items : [parsed];
    for (const o of objects) {
      if (o.metadata.namespace && o.metadata.namespace !== namespace) this.refuse('Helm object outside owned namespace');
      const existing = await this.get(o.kind, o.metadata.name, o.metadata.namespace);
      if (existing) {
        await this.checkObject(existing, state);
        o.metadata.uid = existing.metadata.uid;
        o.metadata.resourceVersion = existing.metadata.resourceVersion;
      }
      this.decorate(o, state);
    }
    return objects;
  }
  async image(args) {
    try { return await this.imageOperation(args); }
    catch (error) { this.refuse(error.message?.startsWith('N2 lab refused') ? 'image ownership refused' : 'image preflight or mutation failed'); }
  }
  async imageOperation(args) {
    const state = await this.assertIdentity();
    const verb = args[0];
    if (verb === 'clean') {
      const present = new Set((await this.execute('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'])).stdout.trim().split(/\s+/));
      const aliases = Object.entries(state.images).filter(([tag]) => present.has(tag));
      const inspect = async (tag, receipt) => {
        const image = JSON.parse((await this.execute('docker', ['image', 'inspect', tag])).stdout)[0];
        if (image.Id !== receipt.id || (receipt.built && (image.Config?.Labels?.[n2RunLabel] !== state.runId
          || image.Config?.Labels?.[n2LabLabel] !== 'n2'))) this.refuse('image alias ownership differs');
        return image;
      };
      for (const [tag, receipt] of aliases) await inspect(tag, receipt);
      const deleting = new Set(aliases.map(([tag]) => tag)), removed = new Set();
      for (const [tag, receipt] of aliases) {
        if (removed.has(receipt.id)) continue;
        await this.assertIdentity();
        const image = await inspect(tag, receipt);
        // Docker cannot conditionally untag a mutable alias. Keep borrowed/shared images and their aliases.
        if (!receipt.built || (image.RepoTags ?? []).some(t => !deleting.has(t)) || image.RepoDigests?.length) continue;
        await this.execute('docker', ['image', 'rm', receipt.id]);
        removed.add(receipt.id);
      }
      return;
    }
    if (!['build', 'tag'].includes(verb)) this.refuse('unsupported image operation');
    const tag = verb === 'tag' ? args[2] : flagValue(args, '-t', '--tag');
    if (!tag?.includes(state.runId)) this.refuse('image tag must include this execution ID');
    const present = (await this.execute('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'])).stdout.trim().split(/\s+/);
    if (present.includes(tag)) this.refuse('preexisting image tag');
    const source = verb === 'tag' ? JSON.parse((await this.execute('docker', ['image', 'inspect', args[1]])).stdout)[0].Id : undefined;
    const result = await this.execute('docker', verb === 'tag' ? ['tag', source, tag] : ['build', '--label', `${n2LabLabel}=n2`, '--label', `${n2RunLabel}=${state.runId}`, ...args.slice(1)]);
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
    const dir = mkdtempSync(join(tmpdir(), 'gromesh-n2-image-'));
    try {
      const archive = join(dir, 'image.tar');
      // Export is read-only. Prove its content before importing: a concurrent retag must never reach a node.
      await this.execute('docker', ['image', 'save', '--output', archive, image]);
      const manifest = JSON.parse((await this.execute('tar', ['-xOf', archive, 'manifest.json'])).stdout);
      const digest = current.Id.replace(/^sha256:/, '');
      if (manifest.length !== 1 || ![`${digest}.json`, `blobs/sha256/${digest}`].includes(manifest[0].Config)
        || !manifest[0].RepoTags?.includes(image)) this.refuse('exported image digest or alias changed');
      for (const node of state.nodes) {
        await this.assertIdentity();
        await this.execute('docker', ['exec', '-i', node.id, 'ctr', '--namespace=k8s.io', 'images', 'import', '--all-platforms', '--digests', '--snapshotter=overlayfs', '-'],
          { input: readFileSync(archive), timeout: 300_000 });
      }
    } catch { this.refuse('image import proof failed'); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
  async preflightFixtures(names) {
    try {
      const state = await this.assertIdentity();
      for (const name of names) {
        const ids = (await this.execute('docker', ['ps', '-aq', '--filter', `name=^/${name}$`])).stdout.trim().split(/\s+/).filter(Boolean);
        if (!ids.length) continue;
        const containers = JSON.parse((await this.execute('docker', ['inspect', ...ids])).stdout);
        if (containers.length !== 1 || containers[0].Id !== state.containers[name]
          || containers[0].Config?.Labels?.[n2RunLabel] !== state.runId || containers[0].Config?.Labels?.[n2LabLabel] !== 'n2') this.refuse('fixture set includes foreign container');
      }
    } catch { this.refuse('fixture preflight failed'); }
  }
  async preflightResources(resources, required = false, { deleting = false } = {}) {
    try {
      const state = await this.assertIdentity();
      const targets = [];
      for (const { type, name, namespace } of resources) {
        const o = await this.get(type, name, namespace);
        if (!o && required) this.refuse('required mutation target missing');
        if (o) {
          await this.checkObject(o, state);
          if (deleting) await this.checkDeleteEffects(o, state);
          targets.push(o);
        }
      }
      if (deleting) this.requireDeleteFence(targets, state);
    } catch { this.refuse('resource preflight failed'); }
  }
  knownClusterBaseline(o, state) {
    if (!o?.metadata?.uid || o.metadata.finalizers?.length || o.metadata.ownerReferences?.length) return false;
    const name = o.metadata.name;
    if (o.kind === 'Node') return state.nodes.some(n => n.nodeName === name && n.nodeUid === o.metadata.uid && n.nodeProviderId === o.spec?.providerID);
    if (['ClusterRole', 'ClusterRoleBinding'].includes(o.kind)) return name.startsWith('system:')
      || ['admin', 'cluster-admin', 'edit', 'view', 'kubeadm:node-autoapprove-bootstrap', 'kubeadm:node-autoapprove-certificate-rotation',
        'kubeadm:kubelet-bootstrap', 'kubeadm:get-nodes', 'kind:local-path-provisioner'].includes(name);
    const known = { StorageClass: ['standard'], PriorityClass: ['system-cluster-critical', 'system-node-critical'],
      PriorityLevelConfiguration: ['catch-all', 'exempt', 'global-default', 'leader-election', 'node-high', 'system', 'workload-high', 'workload-low'],
      FlowSchema: ['catch-all', 'exempt', 'global-default', 'kube-controller-manager', 'kube-scheduler', 'kube-system-service-accounts',
        'leader-election', 'node-high', 'service-accounts', 'system-leader-election', 'system-node-high', 'system-nodes',
        'system-service-accounts', 'system:authenticated', 'system:unauthenticated', 'workload-leader-election'] };
    return known[o.kind]?.includes(name) === true;
  }
  knownSystemBaseline(o, state, inventory, seen = new Set()) {
    if (!o?.metadata?.uid || seen.has(o.metadata.uid) || o.metadata.finalizers?.length) return false;
    const { namespace, name } = o.metadata;
    if (!['kube-system', 'kube-public', 'kube-node-lease', 'default'].includes(namespace)) return false;
    seen = new Set([...seen, o.metadata.uid]);
    const refs = o.metadata.ownerReferences ?? [];
    if (refs.length > 1 || (refs.length === 1 && refs[0].controller !== true)) return false;
    if (refs.length) return refs.every(ref => {
      if (ref.kind === 'Node' && ref.apiVersion === 'v1') return state.nodes.some(n => n.nodeUid === ref.uid && n.nodeName === ref.name
        && ((o.kind === 'Lease' && namespace === 'kube-node-lease' && name === n.nodeName)
          || (o.kind === 'Pod' && o.metadata.annotations?.['kubernetes.io/config.mirror']
            && ['etcd', 'kube-apiserver', 'kube-controller-manager', 'kube-scheduler'].some(component => name === `${component}-${n.nodeName}`))));
      if (!({ Pod: ['ReplicaSet', 'DaemonSet'], ReplicaSet: ['Deployment'], EndpointSlice: ['Service'] }[o.kind] ?? []).includes(ref.kind)) return false;
      const parent = inventory.find(p => p.metadata.uid === ref.uid && p.kind === ref.kind && p.apiVersion === ref.apiVersion && p.metadata.namespace === namespace);
      return parent && this.knownSystemBaseline(parent, state, inventory, seen);
    });
    if (o.kind === 'Lease' && namespace === 'kube-node-lease') return state.nodes.some(n => n.nodeName === name);
    if (namespace === 'default') return ['Service', 'Endpoints'].includes(o.kind) && name === 'kubernetes';
    if (o.kind === 'ConfigMap' && name === 'kube-root-ca.crt') return true;
    if (namespace === 'kube-public') return o.kind === 'ConfigMap' && name === 'cluster-info';
    if (namespace !== 'kube-system') return false;
    const known = { ConfigMap: ['coredns', 'kube-proxy', 'kubeadm-config', 'kubelet-config', 'extension-apiserver-authentication'],
      Deployment: ['coredns'], DaemonSet: ['kube-proxy'], Service: ['kube-dns'], ServiceAccount: ['default', 'coredns', 'kube-proxy'] };
    return known[o.kind]?.includes(name) === true;
  }
  baselineProof(o) {
    const value = structuredClone(o);
    delete value.status;
    delete value.metadata.resourceVersion;
    delete value.metadata.managedFields;
    return sha256(JSON.stringify(value));
  }
  async namespacedResources(namespace) {
    const types = (await this.rawK(['api-resources', '--namespaced=true', '--verbs=list', '-o', 'name'])).stdout.trim().split(/\s+/).filter(Boolean);
    if (!types.length) this.refuse('namespaced API discovery unavailable');
    const objects = [];
    for (const type of types) {
      const list = JSON.parse((await this.rawK(['get', type, ...(namespace ? ['-n', namespace] : ['-A']), '-o', 'json'])).stdout);
      if (!Array.isArray(list?.items)) this.refuse('complete namespaced inventory unavailable');
      objects.push(...list.items);
    }
    return objects;
  }
  async checkInventory(state, namespace) {
    const objects = await this.namespacedResources(namespace);
    for (const o of objects) {
      if (!o?.metadata?.namespace || !o.metadata.uid) this.refuse('inventory object identity missing');
      const baseline = state.baselineNamespacedResources?.[resourceKey(o)];
      const system = ['kube-system', 'kube-public', 'kube-node-lease', 'default'].includes(o.metadata.namespace);
      if (system && baseline && baseline === this.baselineProof(o)) continue;
      if (!await this.createdObject(o, state)) this.refuse('foreign namespaced object or unproved controller chain');
    }
    return objects;
  }
  requireDeleteFence(objects, state) {
    if (objects.length > 1) {
      this.preserve(state, 'Kubernetes cannot condition a multi-object delete atomically');
      this.refuse('batch deletion cannot guarantee refusal without partial mutation');
    }
    if (objects.some(o => ['Namespace', 'Node', 'CustomResourceDefinition', 'PersistentVolumeClaim', 'PersistentVolume'].includes(o.kind))) {
      this.preserve(state, 'cascade or storage deletion has no conditional inventory precondition');
      this.refuse('cascade or storage deletion cannot bind its complete effects atomically');
    }
  }
  async checkDeleteEffects(target, state) {
    if (target.metadata.finalizers?.length || target.spec?.finalizers?.some(f => f !== 'kubernetes')) this.refuse('unproved finalizer effects');
    const inventory = [...await this.namespacedResources(), ...await this.clusterResources()];
    const affected = new Set([target.metadata.uid]);
    for (let changed = true; changed;) {
      changed = false;
      for (const object of inventory) {
        if (!affected.has(object.metadata?.uid) && object.metadata?.ownerReferences?.some(r => affected.has(r.uid))) {
          if (!await this.createdObject(object, state)) this.refuse('foreign dependent in deletion graph');
          affected.add(object.metadata.uid); changed = true;
        }
      }
    }
  }
  preserve(state, reason) {
    const record = { strategy: 'preserve-instead-of-delete', reason, runId: state.runId,
      nodes: state.nodes.map(n => ({ id: n.id, nodeUid: n.nodeUid })), volumes: state.volumes };
    for (const dir of new Set([state.evidenceDir, this.evidenceDir].filter(Boolean))) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'n2-preserved.json'), JSON.stringify(record, null, 2), { mode: 0o600 });
    }
  }
  async clusterResources() {
    const types = (await this.rawK(['api-resources', '--namespaced=false', '--verbs=list', '-o', 'name'])).stdout.trim().split(/\s+/).filter(Boolean);
    if (!types.length) this.refuse('cluster API discovery unavailable');
    const objects = [];
    for (const type of types) {
      if (type === 'namespaces') continue;
      const list = await this.get(type);
      if (!Array.isArray(list?.items)) this.refuse('cluster-scoped inventory unavailable');
      objects.push(...list.items);
    }
    return objects;
  }
  async preflightDestroyCluster() {
    try {
      const state = await this.assertIdentity();
      await this.preflightFixtures(Object.keys(state.containers));
      const namespaces = (await this.get('namespace')).items;
      for (const ns of namespaces) {
        if (ns.metadata.finalizers?.length || ns.metadata.ownerReferences?.length || ns.spec?.finalizers?.some(f => f !== 'kubernetes')) this.refuse('unexpected namespace deletion effects');
        if (state.baselineNamespaces[ns.metadata.name] === ns.metadata.uid) continue;
        await this.checkObject(ns, state);
      }
      await this.pvcs(undefined, state);
      await this.checkInventory(state);
      for (const o of await this.clusterResources()) {
        if (state.baselineClusterResources?.[resourceKey(o)] === this.baselineProof(o)) continue;
        await this.checkObject(o, state);
      }
      return state;
    } catch { this.refuse('cluster destruction preflight failed'); }
  }
  async destroyCluster() {
    return this.requireDestroyFence();
  }
  async requireDestroyFence() {
    const state = await this.preflightDestroyCluster();
    await this.preflightDestroyCluster();
    this.preserve(state, 'Docker has no conditional volume removal; node/namespace destruction has no atomic Kubernetes inventory fence');
    // Even a second inventory cannot prevent a foreign workload appearing before docker rm. Preserve the
    // whole cluster rather than destroying it partially or claiming a UID precondition protects descendants.
    this.refuse('cluster cascade cannot prove all effects at the mutation boundary');
  }
}

async function n2Command([command, ...args]) {
  const lab = new N2Lab();
  if (command === 'n2-create') await lab.createCluster(readFileSync(0, 'utf8'));
  else if (command === 'n2-helm') await lab.helm(args);
  else if (command === 'n2-kubectl') { const result = await lab.kubectl(args); process.stdout.write(result.stdout); }
  else if (command === 'n2-assert') await lab.assertIdentity();
  else if (command === 'n2-down') await lab.destroyCluster();
  else if (command === 'n2-image') await lab.image(args);
  else if (command === 'n2-load') await lab.loadImage(args[0]);
  else if (command === 'n2-pull') await lab.pullImage(args[0]);
  else if (command === 'n2-preflight-down') await lab.requireDestroyFence();
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
