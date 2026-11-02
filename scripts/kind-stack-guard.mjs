// Model H invariants: run-created ephemeral EXCLUSIVE cluster, dedicated kubeconfig/context,
// creation receipts (run/name/kube-system UID/CA), complete expected-kind + run inventory, no
// third-party principals/controllers/storage. Any unexpected identity/activity => persistent STOP;
// preserve evidence, forbid retries and ALL further mutations (including cleanup). Controller
// descendants need creation receipts + template/hash/image proof; labels/ownerReferences alone fail.
// Namespace CREATE and rollout descendants have no atomic UID/inventory fence: checks before/after
// detect races; H assumes a trusted operator and no independent writers, not a hostile administrator.
// Shared clusters (including the existing N2 VM) are forbidden. Product Model P/W0 is unchanged;
// harness tests approve no gate. Cascade/storage deletion remains forbidden; no degraded mode.
import { AsyncLocalStorage } from "node:async_hooks";
import { gunzipSync } from "node:zlib";
import { isIP } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { assertLocalDaemon, daemonProblems } from "./stack-guard.mjs";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, readlinkSync, existsSync, lstatSync, statSync, realpathSync, renameSync, mkdirSync, openSync, closeSync, fstatSync, constants } from "node:fs";
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

export const n2ClusterName = runId => `gromesh-n2-${sha256(runId ?? '').slice(0, 24)}`;
export const n2RunLabel = 'com.grometis.gromesh.n2-run';
export const n2LabLabel = 'com.grometis.gromesh.lab';
const n2Refused = reason => new Error(`N2 lab refused before mutation: ${reason}; ownership proof and evidence preserved`);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const n2SystemAccounts = Object.freeze(['coredns', 'kube-proxy', 'bootstrap-signer', 'token-cleaner',
          'attachdetach-controller', 'certificate-controller', 'clusterrole-aggregation-controller', 'cronjob-controller', 'daemon-set-controller',
          'deployment-controller', 'disruption-controller', 'endpoint-controller', 'endpointslice-controller', 'endpointslicemirroring-controller',
          'ephemeral-volume-controller', 'expand-controller', 'generic-garbage-collector', 'horizontal-pod-autoscaler', 'job-controller',
          'namespace-controller', 'node-controller', 'persistent-volume-binder', 'pod-garbage-collector', 'pv-protection-controller',
          'pvc-protection-controller', 'replicaset-controller', 'replication-controller', 'resourcequota-controller', 'root-ca-cert-publisher',
          'service-account-controller', 'service-controller', 'statefulset-controller', 'ttl-after-finished-controller', 'ttl-controller',
          'validatingadmissionpolicy-status-controller', 'legacy-service-account-token-cleaner', 'service-cidrs-controller', 'selinux-warning-controller']);
const pinnedDirectories = new Set();
process.once('exit', () => { for (const dir of pinnedDirectories) rmSync(dir, { recursive: true, force: true }); });
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
    this.execute = (command, args, options = {}) => {
      this.assertNotRefused();
      if (this.pinnedConfig) this.verifyPinnedConfig();
      return execute(command, args, { ...options, env: { ...this.env, ...options.env, HELM_DRIVER: 'secret',
        ...(this.pinnedConfig ? { KUBECONFIG: this.pinnedConfig, LAB_N2_PINNED_CONFIG: this.pinnedConfig } : {}) } });
    };
    this.cluster = n2ClusterName(env.LAB_RUN_ID);
    this.context = `kind-${this.cluster}`;
    this.kubeconfig = env.LAB_KUBECONFIG;
    this.statePath = `${this.kubeconfig}.n2-owner.json`;
    this.refusalPath = `${this.statePath}.refused`;
    this.explicitEvidence = env.LAB_EVIDENCE_DIR ?? env.OUT ?? env.LAB_OUT;
    this.evidenceDir = this.explicitEvidence ?? (this.kubeconfig ? dirname(resolve(this.kubeconfig)) : undefined);
    this.refused = false;
    this.queue = Promise.resolve();
    this.exitBindings = new WeakSet();
    this.operationContext = new AsyncLocalStorage();
    this.operationQueue = Promise.resolve();
  }
  async withOperation(fn, creating = false) {
    this.assertNotRefused();
    if (this.operationContext.getStore() === this) return fn();
    const run = async () => {
      this.assertNotRefused();
      try { this.pathProof(creating); } catch (error) { if (error.message?.startsWith('N2 lab refused')) throw error; this.refuse('exclusive path proof unavailable'); }
      const lock = `${this.statePath}.active`;
      try { mkdirSync(lock, { mode: 0o700 }); }
      catch { this.refuse('concurrent or interrupted operation; preserve evidence'); }
      try {
        return await this.operationContext.run(this, async () => {
          const result = await fn();
          await this.assertIdentity();
          return result;
        });
      }
      finally { if (!this.refused && !existsSync(this.refusalPath)) rmSync(lock, { recursive: true }); }
    };
    const result = this.operationQueue.then(run);
    this.operationQueue = result.catch(() => {});
    return result;
  }
  recordResource(o, state) {
    state.resources[resourceKey(o)] = o.metadata.uid;
    state.resourceOwners ??= {}; state.resourceOwners[resourceKey(o)] = o.metadata.ownerReferences ?? [];
    state.resourceProofs ??= {}; state.resourceProofs[resourceKey(o)] = this.baselineProof(o);
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
  pinKubeconfig() {
    if (this.pinnedConfig) return;
    const inherited = this.env.LAB_N2_PINNED_CONFIG;
    const path = inherited ?? this.pathProof();
    if (inherited) {
      const dir = lstatSync(dirname(path)), file = lstatSync(path);
      if (!dirname(path).split('/').at(-1).startsWith('gromesh-n2-config-') || path.split('/').at(-1) !== 'config'
        || dir.isSymbolicLink() || !dir.isDirectory() || (dir.mode & 0o777) !== 0o700 || (file.mode & 0o777) !== 0o600)
        this.refuse('inherited kubeconfig is not a private execution copy');
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes, st;
    try {
      st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1) this.refuse('kubeconfig source is not exclusive');
      bytes = readFileSync(fd);
    } finally { closeSync(fd); }
    this.sourceConfig = { path: inherited ? join(realpathSync(dirname(resolve(this.kubeconfig))), resolve(this.kubeconfig).split('/').at(-1)) : path, inode: `${st.dev}:${st.ino}`, hash: sha256(bytes), inherited: Boolean(inherited) };
    const dir = mkdtempSync(join(tmpdir(), 'gromesh-n2-config-'));
    pinnedDirectories.add(dir);
    this.pinnedConfig = join(dir, 'config');
    writeFileSync(this.pinnedConfig, bytes, { mode: 0o600, flag: 'wx' });
    this.pinnedHash = sha256(bytes);
    this.validatedPath = true;
  }
  verifyPinnedConfig() {
    const st = lstatSync(this.pinnedConfig), dir = lstatSync(dirname(this.pinnedConfig));
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (st.mode & 0o777) !== 0o600
      || !dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o777) !== 0o700
      || sha256(readFileSync(this.pinnedConfig)) !== this.pinnedHash) this.refuse('private kubeconfig changed');
  }
  load() {
    this.pinKubeconfig();
    const st = lstatSync(this.statePath);
    if (!st.isFile() || st.nlink !== 1 || st.isSymbolicLink()) this.refuse('invalid creation receipt');
    const state = JSON.parse(readFileSync(this.statePath, 'utf8'));
    const source = this.sourceConfig;
    if (state.creation?.model !== 'H' || state.creation?.exclusive !== true || state.creation?.runId !== state.runId
      || state.creation?.cluster !== this.cluster || state.phase !== 'ready' || state.cluster !== this.cluster || state.context !== this.context || state.kubeconfig !== source.path
      || (!source.inherited && state.kubeconfigInode !== source.inode) || state.kubeconfigHash !== source.hash || !/^[a-z0-9-]{12,63}$/.test(state.runId ?? '')
      || (this.env.LAB_RUN_ID && this.env.LAB_RUN_ID !== state.runId)) this.refuse('creation receipt does not match this execution');
    return state;
  }
  save(state) {
    const temp = `${this.statePath}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(temp, this.statePath);
  }
  verifiedKubeconfig() {
    this.assertNotRefused();
    if (!this.provedEndpoint) this.refuse('cluster identity has not been proved');
    this.verifyPinnedConfig();
    return this.pinnedConfig;
  }
  clusterFlags(args) {
    if (args.some(a => /^(--kubeconfig|--context|--kube-context|--server|--kube-apiserver|--certificate-authority|--insecure-skip-tls-verify|--token|--kube-token)(=|$)/.test(a)))
      this.refuse('cluster configuration override forbidden');
  }
  async rawK(args, options) {
    this.clusterFlags(args);
    this.pinKubeconfig();
    return this.execute('kubectl', ['--kubeconfig', this.pinnedConfig, '--context', this.context, ...args], options);
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
    const current = JSON.parse((await this.rawK(['config', 'view', '--raw', '-o', 'json'])).stdout);
    // kind exports self-contained credentials. External files/plugins would restore a mutable dependency.
    if (current.clusters?.some(c => c.cluster?.['certificate-authority'] || c.cluster?.['insecure-skip-tls-verify'])
      || current.users?.some(u => ['client-certificate', 'client-key', 'exec', 'auth-provider', 'tokenFile'].some(k => u.user?.[k])))
      this.refuse('kubeconfig must contain self-contained credentials');
    if (current.users?.length !== 1 || !current.users[0]?.user?.['client-certificate-data'] || !current.users[0]?.user?.['client-key-data']
      || current.contexts?.[0]?.context?.user !== current.users[0].name) this.refuse('one dedicated creation credential required');
    const endpoint = JSON.stringify(current.clusters);
    if (this.provedEndpoint && endpoint !== this.provedEndpoint) this.refuse('private kubeconfig server or CA changed');
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
    this.provedEndpoint = endpoint;
    const system = await this.get('namespace', 'kube-system');
    if (!system?.metadata?.uid) this.refuse('kube-system UID missing');
    return { marker: system.metadata.labels?.[n2RunLabel], uid: system.metadata.uid, caHash: sha256(Buffer.from(current.clusters[0].cluster['certificate-authority-data'], 'base64')) };
  }
  async assertIdentity(pendingState) {
    try {
      this.assertNotRefused();
      const persisted = this.load();
      if (pendingState && (pendingState.runId !== persisted.runId || pendingState.uid !== persisted.uid)) this.refuse('pending operation identity changed');
      const state = pendingState ?? persisted;
      if (state.evidenceDir && existsSync(join(state.evidenceDir, 'n2-refused.json'))) this.refuse('previous run refusal');
      await this.daemon();
      const identity = await this.identity();
      this.proofEvidence('identity', { expected: { uid: state.uid, caHash: state.caHash, runId: state.runId }, actual: identity });
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
      await this.assertExclusive(state, { persist: !pendingState });
      return state;
    } catch (error) { if (error.message?.startsWith('N2 lab refused')) throw error; this.refuse('identity proof unavailable'); }
  }
  proofEvidence(phase, value) {
    if (!this.evidenceDir) this.refuse('evidence directory required');
    mkdirSync(this.evidenceDir, { recursive: true });
    const bytes = JSON.stringify(value, null, 2);
    const file = join(this.evidenceDir, `n2-${phase}-${sha256(bytes)}.json`);
    try { writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  inventoryEvidence(phase, inventory) {
    if (!this.evidenceDir) this.refuse('evidence directory required');
    mkdirSync(this.evidenceDir, { recursive: true });
    const objects = inventory.map(o => ({ key: resourceKey(o), uid: o.metadata.uid,
      resourceVersion: o.metadata.resourceVersion, owners: o.metadata.ownerReferences ?? [], proof: this.unrelatedProof(o) }));
    const bytes = JSON.stringify(objects, null, 2), first = join(this.evidenceDir, `n2-inventory-${phase}.json`);
    const file = existsSync(first) ? join(this.evidenceDir, `n2-inventory-${phase}-${sha256(bytes)}.json`) : first;
    try { writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  systemCoordination(o, state) {
    if (o.kind !== 'Lease' || o.apiVersion !== 'coordination.k8s.io/v1') return false;
    const { name, namespace } = o.metadata;
    if (namespace === 'kube-node-lease') return state ? state.nodes.some(n => n.nodeName === name) : true;
    return namespace === 'kube-system' && ['kube-controller-manager', 'kube-scheduler'].includes(name);
  }
  expectedPrincipals(o, state, baseline = false) {
    if (!['RoleBinding', 'ClusterRoleBinding'].includes(o.kind)) return true;
    return (o.subjects ?? []).every(subject => {
      if (subject.kind === 'ServiceAccount') {
        if (baseline) return (subject.namespace === 'kube-system' && n2SystemAccounts.includes(subject.name))
          || (subject.namespace === 'local-path-storage' && subject.name === 'local-path-provisioner-service-account');
        return Boolean(state.resources[`serviceaccount/${subject.namespace}/${subject.name}`] || subject.name === 'default' && state.resources[`namespace//${subject.namespace}`]);
      }
      if (!baseline) return false;
      if (subject.kind === 'Group') return ['system:authenticated', 'system:unauthenticated', 'system:masters', 'kubeadm:cluster-admins',
        'system:serviceaccounts', 'system:serviceaccounts:kube-system', 'system:nodes', 'system:bootstrappers:kubeadm:default-node-token'].includes(subject.name);
      return subject.kind === 'User' && ['system:kube-controller-manager', 'system:kube-scheduler', 'system:kube-proxy',
        'kube-apiserver-kubelet-client', 'kubernetes-admin', 'kubernetes-super-admin'].includes(subject.name);
    });
  }
  checkManifestStorage(o, state) {
    if (o.kind === 'PersistentVolume') this.refuse('PV provisioning has no exclusive storage receipt; preserve storage');
    if (o.kind === 'StorageClass' && (o.metadata.name !== 'standard' || o.provisioner !== 'rancher.io/local-path')) this.refuse('external storage provisioner forbidden');
    if (o.kind === 'PersistentVolumeClaim' && (o.spec?.volumeName || o.spec?.dataSource || o.spec?.dataSourceRef || o.spec?.storageClassName && o.spec.storageClassName !== 'standard')) this.refuse('PVC cannot borrow or clone external storage');
    const specs = [o.kind === 'Pod' ? o.spec : undefined, o.spec?.template?.spec, o.spec?.jobTemplate?.spec?.template?.spec].filter(Boolean);
    for (const spec of specs) for (const volume of spec.volumes ?? []) {
      // Cilium's node-local paths are inside the new kind node, whose Docker mounts were proved
      // exclusive. Arbitrary host paths and network/storage drivers are never admitted.
      const cilium = o.metadata?.namespace === 'kube-system' && ['cilium', 'cilium-envoy', 'cilium-operator'].includes(o.metadata.name);
      const localPaths = ['/proc', '/sys', '/sys/fs/bpf', '/sys/fs/cgroup', '/var/run/cilium', '/var/run/netns', '/var/run/cilium/envoy/sockets',
        '/var/lib/cni/networks', '/etc/cni/net.d', '/opt/cni/bin', '/lib/modules', '/run/xtables.lock'];
      if (volume.hostPath && !(cilium && localPaths.includes(volume.hostPath.path))) this.refuse('unproved hostPath volume');
      if (['csi', 'nfs', 'flexVolume', 'iscsi', 'rbd', 'cephfs', 'awsElasticBlockStore', 'gcePersistentDisk', 'azureDisk', 'azureFile'].some(k => volume[k])) this.refuse('shared or external volume forbidden');
      if (volume.persistentVolumeClaim && !state.resources[`persistentvolumeclaim/${o.metadata.namespace}/${volume.persistentVolumeClaim.claimName}`]) this.refuse('unproved pod PVC');
    }
  }
  templateImages(spec) {
    return JSON.stringify(['containers', 'initContainers'].map(type => (spec?.[type] ?? []).map(c => [c.name, c.image])));
  }
  controllerReceipt(o, state) {
    const receipt = state.controllerReceipts?.[resourceKey(o)];
    return receipt?.uid === o.metadata.uid && receipt.proof === this.baselineProof(o);
  }
  async recordControllerChild(o, state, inventory) {
    if (state.resources[resourceKey(o)] || this.controllerReceipt(o, state)) return false;
    const refs = o.metadata.ownerReferences ?? [], ref = refs[0];
    if (refs.length !== 1 || ref.controller !== true || !this.owns(o, state) || o.metadata.finalizers?.length) return false;
    const parent = inventory.find(p => p.kind === ref.kind && p.apiVersion === ref.apiVersion && p.metadata.uid === ref.uid
      && p.metadata.name === ref.name && p.metadata.namespace === o.metadata.namespace);
    if (!parent || !await this.createdObject(parent, state)) return false;
    // Under H only the expected system controller may create descendants. This observation is a
    // receipt in the exclusive cluster, not a cryptographic attribution against a hostile API writer.
    if (!o.metadata.managedFields?.some(f => f.manager === 'kube-controller-manager' && f.operation === 'Update')
      || !o.metadata.creationTimestamp || Date.parse(o.metadata.creationTimestamp) < Date.parse(state.createdAt)) return false;
    let template;
    if (o.kind === 'ReplicaSet' && parent.kind === 'Deployment') template = parent.spec?.template;
    else if (o.kind === 'Pod' && ['ReplicaSet', 'DaemonSet', 'StatefulSet', 'Job'].includes(parent.kind)) template = parent.spec?.template;
    else if (o.kind === 'Job' && parent.kind === 'CronJob') template = parent.spec?.jobTemplate;
    else return false;
    const spec = o.kind === 'Pod' ? o.spec : o.spec?.template?.spec;
    const expectedSpec = o.kind === 'Job' ? template?.spec?.template?.spec : template?.spec;
    if (!expectedSpec || this.templateImages(spec) !== this.templateImages(expectedSpec)) return false;
    const templateHash = o.metadata.labels?.['pod-template-hash'];
    if (parent.kind === 'ReplicaSet' || o.kind === 'ReplicaSet') {
      const expectedHash = parent.kind === 'ReplicaSet' ? parent.spec?.template?.metadata?.labels?.['pod-template-hash'] : o.spec?.template?.metadata?.labels?.['pod-template-hash'];
      if (!templateHash || templateHash !== expectedHash) return false;
    }
    state.controllerReceipts ??= {};
    state.controllerReceipts[resourceKey(o)] = { uid: o.metadata.uid, controllerUid: parent.metadata.uid,
      templateHash: templateHash ?? null, images: this.templateImages(expectedSpec), proof: this.baselineProof(o) };
    return true;
  }
  expectedGenerated(o, state, inventory) {
    const { namespace, name, uid } = o.metadata;
    const refs = o.metadata.ownerReferences ?? [];
    if (o.metadata.finalizers?.length || !uid) return false;
    if (o.kind === 'Event') {
      const ref = o.involvedObject ?? o.regarding;
      const subject = ref && inventory.find(p => p.metadata.uid === ref.uid && p.kind === ref.kind && p.metadata.name === ref.name && p.metadata.namespace === ref.namespace);
      const known = subject && (state.resources[resourceKey(subject)] === subject.metadata.uid || this.controllerReceipt(subject, state)
        || state.baselineNamespacedResources?.[resourceKey(subject)] === this.baselineProof(subject) || state.baselineClusterResources?.[resourceKey(subject)] === this.baselineProof(subject));
      return Boolean(known && ['kubelet', 'default-scheduler', 'kube-controller-manager', 'replicaset-controller', 'deployment-controller', 'daemonset-controller', 'statefulset-controller', 'job-controller'].includes(o.reportingController ?? o.source?.component));
    }
    if (!namespace || !state.resources[`namespace//${namespace}`] || refs.length > 1) return false;
    const manager = o.metadata.managedFields?.some(f => ['kube-controller-manager', 'endpoint-controller', 'endpointslice-controller'].includes(f.manager) && f.operation === 'Update');
    if (!manager || !o.metadata.creationTimestamp || Date.parse(o.metadata.creationTimestamp) < Date.parse(state.createdAt)) return false;
    if (o.kind === 'ServiceAccount') return name === 'default' && !refs.length && !o.secrets?.length && !o.imagePullSecrets?.length;
    if (o.kind === 'ConfigMap') return name === 'kube-root-ca.crt' && !refs.length && typeof o.data?.['ca.crt'] === 'string'
      && sha256(o.data['ca.crt']) === state.caHash && Object.keys(o.data).length === 1;
    if (['Endpoints', 'EndpointSlice'].includes(o.kind)) {
      const serviceName = o.kind === 'Endpoints' ? name : o.metadata.labels?.['kubernetes.io/service-name'];
      const service = inventory.find(p => p.kind === 'Service' && p.metadata.namespace === namespace && p.metadata.name === serviceName);
      if (!service || state.resources[resourceKey(service)] !== service.metadata.uid || !service.spec?.selector) return false;
      return o.kind === 'Endpoints' ? !refs.length : refs.length === 1 && refs[0].kind === 'Service' && refs[0].uid === service.metadata.uid && refs[0].controller === true;
    }
    return false;
  }
  async exclusiveDockerVolumes(state) {
      const allIds = (await this.execute('docker', ['ps', '-aq'])).stdout.trim().split(/\s+/).filter(Boolean);
      const allContainers = allIds.length ? JSON.parse((await this.execute('docker', ['inspect', ...allIds])).stdout) : [];
      for (const container of allContainers) {
        const ownedNode = state.nodes.some(n => n.id === container.Id);
        const fixtureName = container.Name?.replace(/^\//, '');
        if (fixtureName?.startsWith(`${this.cluster}-fx-`) && (state.containers[fixtureName] !== container.Id || container.Config?.Labels?.[n2RunLabel] !== state.runId || container.Config?.Labels?.[n2LabLabel] !== 'n2')) this.refuse('unexpected fixture container or lost ownership');
        if (!ownedNode && (container.Mounts ?? []).some(m => state.volumes[m.Name] || state.nodes.some(n => n.mounts.some(own => own[2] === m.Source)))) this.refuse('node volume is shared with another container');
      }
  }
  async assertExclusive(state, { persist = true } = {}) {
    this.assertNotRefused();
    if (state.creation?.model !== 'H' || !state.creation.exclusive || state.cluster !== this.cluster || state.creation.runId !== state.runId)
      this.refuse('exclusive run-created cluster receipt required');
    await this.exclusiveDockerVolumes(state);
    const namespaces = (await this.get('namespace')).items;
    const inventory = [...await this.namespacedResources(), ...await this.clusterResources()];
    this.inventoryEvidence('exclusive', [...namespaces, ...inventory]);
    for (const ns of namespaces) {
      if (state.baselineNamespaces?.[ns.metadata.name] === ns.metadata.uid && !ns.metadata.ownerReferences?.length && !ns.metadata.finalizers?.length) continue;
      if (!await this.createdObject(ns, state)) this.refuse('exclusivity lost: unexpected namespace');
    }
    let recorded = false;
    for (let pass = 0; pass < 4; pass++) {
      for (const o of inventory) recorded = await this.recordControllerChild(o, state, inventory) || recorded;
    }
    for (const o of inventory) {
      if (!o.metadata?.uid) this.refuse('inventory identity unavailable');
      const baseline = state.baselineNamespacedResources?.[resourceKey(o)] ?? state.baselineClusterResources?.[resourceKey(o)];
      if (baseline && baseline === this.baselineProof(o) && this.expectedPrincipals(o, state, true)) continue;
      if (this.expectedGenerated(o, state, inventory)) continue;
      if (!await this.createdObject(o, state) || !this.expectedPrincipals(o, state)) this.refuse('exclusivity lost: foreign resource, controller, storage or principal');
      if (o.kind === 'Pod' && state.controllerReceipts?.[resourceKey(o)]) {
        const parent = inventory.find(p => p.metadata.uid === state.controllerReceipts[resourceKey(o)].controllerUid);
        this.checkManifestStorage(parent ?? o, state);
      } else this.checkManifestStorage(o, state);
    }
    if (recorded && persist) this.save(state);
    return inventory;
  }
  async createCluster(config) {
    return this.withOperation(() => this.createClusterOperation(config), true);
  }
  async createClusterOperation(config) {
    try {
      this.assertNotRefused();
      const path = this.pathProof(true);
      const runId = this.env.LAB_RUN_ID;
      if (!runId || !/^[a-z0-9-]{12,63}$/.test(runId)) this.refuse('invalid LAB_RUN_ID');
      if (/\b(extraMounts|extraPortMappings|kubeadmConfigPatches|kubeadmConfigPatchesJSON6902)\s*:/.test(config)) this.refuse('unproved shared mounts or bootstrap patches');
      await this.daemon();
      const clusters = (await this.execute('kind', ['get', 'clusters'])).stdout.trim().split(/\s+/);
      const ids = (await this.execute('docker', ['ps', '-aq', '--filter', `label=io.x-k8s.kind.cluster=${this.cluster}`])).stdout.trim();
      if (clusters.includes(this.cluster) || ids) this.refuse('preexisting cluster or kind nodes');
      const oldVolumes = new Set((await this.execute('docker', ['volume', 'ls', '-q'])).stdout.trim().split(/\s+/));
      const state = { phase: 'creating', createdAt: new Date().toISOString(), creation: { model: 'H', runId, cluster: this.cluster, exclusive: false }, runId, cluster: this.cluster, context: this.context, kubeconfig: path, evidenceDir: this.evidenceDir, resources: {}, containers: {}, images: {} };
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
      if (nodes.some(n => (n.Mounts ?? []).some(m => m.Type !== 'volume' || oldVolumes.has(m.Name)))) this.refuse('node mounted a preexisting volume');
      state.volumes = {};
      for (const name of nodes.flatMap(n => (n.Mounts ?? []).filter(m => m.Type === 'volume').map(m => m.Name))) {
        state.volumes[name] = JSON.parse((await this.execute('docker', ['volume', 'inspect', name])).stdout)[0];
      }
      Object.assign(state, identity, { phase: 'ready', kubeconfigInode: this.sourceConfig.inode, kubeconfigHash: this.sourceConfig.hash });
      const clusterObjects = await this.clusterResources(), baseline = await this.namespacedResources();
      const namespaces = (await this.get('namespace')).items;
      this.inventoryEvidence('creation', [...namespaces, ...clusterObjects, ...baseline]);
      if (namespaces.some(n => !['default', 'kube-system', 'kube-public', 'kube-node-lease', 'local-path-storage'].includes(n.metadata.name)
        || !n.metadata.uid || n.metadata.ownerReferences?.length || n.metadata.finalizers?.length)) this.refuse('unexpected namespace at creation');
      for (const o of clusterObjects) if (!this.knownClusterBaseline(o, state) || !this.expectedPrincipals(o, state, true)) this.refuse('unexpected cluster baseline or RBAC subject');
      const eventState = { ...state, baselineClusterResources: Object.fromEntries(clusterObjects.map(o => [resourceKey(o), this.baselineProof(o)])), baselineNamespacedResources: Object.fromEntries(baseline.filter(o => o.kind !== 'Event' && this.knownSystemBaseline(o, state, baseline)).map(o => [resourceKey(o), this.baselineProof(o)])) };
      for (const o of baseline) if (!(this.knownSystemBaseline(o, state, baseline) || this.expectedGenerated(o, eventState, [...clusterObjects, ...baseline])) || !this.expectedPrincipals(o, state, true)) this.refuse('unexpected namespaced creation baseline');
      state.baselineClusterResources = Object.fromEntries(clusterObjects.map(o => [resourceKey(o), this.baselineProof(o)]));
      state.baselineNamespacedResources = Object.fromEntries(baseline.map(o => [resourceKey(o), this.baselineProof(o)]));
      state.baselineNamespaces = Object.fromEntries(namespaces.map(n => [n.metadata.name, n.metadata.uid]));
      state.creation.exclusive = true;
      state.system = {};
      for (const [type, name] of [['configmap', 'coredns'], ['deployment', 'coredns']]) {
        const o = await this.get(type, name, 'kube-system');
        if (!o?.metadata?.uid) this.refuse('CoreDNS identity missing');
        state.system[`${type}/${name}`] = o.metadata.uid;
      }
      this.save(state);
      const beforeMark = await this.identity();
      if (beforeMark.uid !== state.uid || beforeMark.caHash !== state.caHash) this.refuse('identity changed before marking');
      await this.assertExclusive(state);
      await this.rawK(['label', 'namespace', 'kube-system', `${n2LabLabel}=n2`, `${n2RunLabel}=${runId}`, `--resource-version=${(await this.get('namespace', 'kube-system')).metadata.resourceVersion}`]);
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
    if (receipt && state.resourceProofs?.[resourceKey(o)] && state.resourceProofs[resourceKey(o)] !== this.baselineProof(o)) return false;
    if (receipt && (receipt !== o.metadata.uid || JSON.stringify(refs) !== JSON.stringify(state.resourceOwners?.[resourceKey(o)] ?? []))) return false;
    if (!receipt && !this.controllerReceipt(o, state)) return false;
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
  workload(o) { return ['Deployment', 'ReplicaSet', 'DaemonSet', 'StatefulSet', 'Job', 'CronJob'].includes(o?.kind); }
  matchesSelector(object, selector) {
    if (!selector || (!selector.matchLabels && !selector.matchExpressions)) this.refuse('controller selector unavailable');
    const labels = object.metadata.labels ?? {};
    if (!Object.entries(selector.matchLabels ?? {}).every(([k, v]) => labels[k] === v)) return false;
    return (selector.matchExpressions ?? []).every(e => {
      if (e.operator === 'In') return e.values?.includes(labels[e.key]);
      if (e.operator === 'NotIn') return !e.values?.includes(labels[e.key]);
      if (e.operator === 'Exists') return Object.hasOwn(labels, e.key);
      if (e.operator === 'DoesNotExist') return !Object.hasOwn(labels, e.key);
      this.refuse('unsupported controller selector');
    });
  }
  unrelatedProof(o) {
    const object = structuredClone(o);
    delete object.metadata.resourceVersion;
    delete object.metadata.managedFields;
    return sha256(JSON.stringify(object));
  }
  rolloutEvidence(phase, inventory) {
    if (!this.evidenceDir) return;
    mkdirSync(this.evidenceDir, { recursive: true });
    // Keep identity and content fingerprints, never Secret payloads or credentials.
    this.inventoryEvidence(`rollout-${phase}`, inventory);
  }
  async rolloutInventory(workloads, state, phase = 'before') {
    const inventory = [...await this.namespacedResources(), ...await this.clusterResources()];
    this.rolloutEvidence(phase, inventory);
    const affected = new Set(workloads.map(o => o.metadata.uid).filter(Boolean));
    for (let changed = true; changed;) {
      changed = false;
      const controllers = [...workloads.filter(o => this.workload(o)), ...inventory.filter(o => affected.has(o.metadata.uid) && this.workload(o))];
      for (const o of inventory) {
        const selected = controllers.some(w => o.metadata.namespace === w.metadata.namespace
          && ['Pod', 'ReplicaSet'].includes(o.kind) && w.kind !== 'CronJob'
          && !(w.kind === 'Job' && !w.spec?.selector && !w.spec?.manualSelector) && this.matchesSelector(o, w.spec?.selector));
        if (!selected && !o.metadata.ownerReferences?.some(r => affected.has(r.uid))) continue;
        const baseline = state.baselineNamespacedResources?.[resourceKey(o)];
        if (!(baseline && baseline === this.baselineProof(o)) && !await this.createdObject(o, state))
          this.refuse('rollout may replace an object without creation ownership');
        if (!affected.has(o.metadata.uid)) { affected.add(o.metadata.uid); changed = true; }
      }
    }
    const unrelated = [];
    for (const o of inventory.filter(o => !affected.has(o.metadata.uid))) {
      const key = resourceKey(o);
      const baseline = state.baselineNamespacedResources?.[key] ?? state.baselineClusterResources?.[key];
      const node = o.kind === 'Node' && state.nodes.some(n => n.nodeUid === o.metadata.uid);
      const generated = this.expectedGenerated(o, state, inventory);
      if (!(node || (baseline && baseline === this.baselineProof(o)) || generated || await this.createdObject(o, state))) this.refuse('exclusivity lost: foreign object in rollout inventory');
      if (this.systemCoordination(o, state) || generated && ['Event', 'Endpoints', 'EndpointSlice'].includes(o.kind)) continue;
      unrelated.push({ key, uid: o.metadata.uid, proof: this.baselineProof(o) });
    }
    return { workloads, unrelated };
  }
  async verifyRollout(before, state) {
    await this.assertIdentity(state);
    const after = [...await this.namespacedResources(), ...await this.clusterResources()];
    this.rolloutEvidence('after', after);
    for (const object of before.unrelated) {
      const current = after.find(o => resourceKey(o) === object.key);
      if (!current || current.metadata.uid !== object.uid || this.baselineProof(current) !== object.proof)
        this.refuse('rollout affected an unrelated object; preserve evidence');
    }
    await this.rolloutInventory(before.workloads, state, 'after');
  }
  async mutateWorkload(current, state, write) {
    this.assertNotRefused();
    await this.assertExclusive(state);
    if (!this.workload(current)) return write();
    const before = await this.rolloutInventory([current], state);
    await this.assertExclusive(state);
    const latest = await this.get(current.kind, current.metadata.name, current.metadata.namespace);
    if (!latest || latest.metadata.uid !== current.metadata.uid || latest.metadata.resourceVersion !== current.metadata.resourceVersion) this.refuse('rollout target UID or resourceVersion changed');
    await this.rolloutInventory([current], state, 'boundary');
    const result = await write();
    const system = current.metadata.namespace === 'kube-system' && state.system?.[`${current.kind.toLowerCase()}/${current.metadata.name}`] === current.metadata.uid;
    if (result.stdout?.trim().startsWith('{')) {
      const actual = JSON.parse(result.stdout);
      if (actual.metadata?.uid === current.metadata.uid) this.recordResource(actual, state);
    }
    if (system) {
      const actual = JSON.parse(result.stdout);
      if (actual.metadata?.uid !== current.metadata.uid || !this.owns(actual, state)) this.refuse('system workload mutation lost its UID binding');
      this.recordResource(actual, state);
    }
    await this.verifyRollout(before, state);
    this.save(state);
    return result;
  }
  serialized(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  kubectl(args, options = {}) {
    return this.serialized(async () => {
      try { return await this.withOperation(() => this.kubeOperation(args, options)); }
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
    if (verb === 'rollout' && !args.includes('restart')) this.refuse('unsupported rollout mutation');
    if (['apply', 'create'].includes(verb)) {
      if (!args.includes('-f') || flagValue(args, '-f') !== '-') this.refuse('manifests must go through guarded stdin');
      let parsed;
      try { parsed = JSON.parse(options.input); }
      catch { parsed = JSON.parse((await this.rawK(['create', '--dry-run=client', '-n', namespace ?? 'default', '-f', '-', '-o', 'json'], options)).stdout); }
      const objects = parsed.kind === 'List' ? parsed.items : [parsed];
      // Preflight the whole batch before the first write.
      for (const o of objects) {
        if (namespace) o.metadata.namespace ??= namespace;
        this.checkManifestStorage(o, state);
        const existing = await this.get(o.kind, o.metadata.name, o.metadata.namespace);
        if (existing) await this.checkObject(existing, state);
        else if (o.metadata.namespace && !objects.some(n => n.kind === 'Namespace' && n.metadata.name === o.metadata.namespace)) await this.ownedNamespace(o.metadata.namespace, state);
      }
      let result;
      for (const o of objects) {
        await this.assertIdentity();
        const namespaceProof = o.metadata.namespace ? await this.ownedNamespace(o.metadata.namespace, state) : undefined;
        if (namespaceProof) {
          o.metadata.labels = { ...o.metadata.labels, 'com.grometis.gromesh.n2-namespace-uid': namespaceProof.metadata.uid };
          o.metadata.annotations = { ...o.metadata.annotations, 'gromesh.io/n2-namespace-uid': namespaceProof.metadata.uid };
        }
        const existing = await this.get(o.kind, o.metadata.name, o.metadata.namespace);
        if (existing) {
          await this.checkObject(existing, state);
          o.metadata.uid = existing.metadata.uid;
          o.metadata.resourceVersion = existing.metadata.resourceVersion;
        }
        result = await this.mutateWorkload(existing, state, async () => {
          if (namespaceProof && (await this.ownedNamespace(o.metadata.namespace, state)).metadata.uid !== namespaceProof.metadata.uid) this.refuse('namespace UID changed before create');
          return this.rawK([existing ? 'apply' : 'create', '-f', '-', '-o', 'json'], { ...options, input: JSON.stringify(this.decorate(o, state)), allowFail: false });
        });
        if (namespaceProof && (await this.ownedNamespace(o.metadata.namespace, state)).metadata.uid !== namespaceProof.metadata.uid) this.refuse('namespace UID changed after create; preserve evidence');
        const actual = JSON.parse(result.stdout);
        if (!actual.metadata?.uid) this.refuse('created resource has no UID receipt');
        this.recordResource(actual, state);
        await this.assertIdentity(state);
        this.save(state);
      }
      return result;
    }
    if (verb === 'run') {
      if (args.includes('--rm') || args.includes('--attach') || args.includes('-i') || args.includes('-t')) this.refuse('interactive run forbidden; use a guarded pod manifest');
      const generated = await this.rawK([...args, '--dry-run=client', '-o', 'json'], options);
      return this.kubeOperation(['create', '-f', '-', ...(namespace ? ['-n', namespace] : [])], { ...options, input: generated.stdout });
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
      return this.mutateWorkload(current, state, () => this.rawK(['apply', '-f', '-', '-o', 'json'], { ...options, input: JSON.stringify(this.decorate(object, state)), allowFail: false }));
    }
    if (verb === 'set') {
      const generated = JSON.parse((await this.rawK([...args, '--dry-run=client', '-o', 'json'], options)).stdout);
      this.checkManifestStorage(generated, state);
      generated.metadata.uid = current.metadata.uid;
      generated.metadata.resourceVersion = current.metadata.resourceVersion;
      return this.mutateWorkload(current, state, () => this.rawK(['apply', '-f', '-', '-o', 'json'], { ...options, input: JSON.stringify(this.decorate(generated, state)), allowFail: false }));
    }
    if (verb === 'scale') return this.mutateWorkload(current, state, () => this.rawK([...args, `--resource-version=${current.metadata.resourceVersion}`, '-o', 'json'], options));
    if (verb === 'patch') this.refuse('patch requires a guarded object manifest');
    return this.rawK(args, options);
  }
  async docker(args, options = {}) {
    try { return await this.withOperation(() => this.dockerOperation(args, options)); }
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
      for (const arg of args) {
        if (/^(?:-v|--volume|--mount|--volumes-from|--privileged)(?:=|$)/.test(arg)) this.refuse('fixture shared mounts or privilege forbidden');
      }
      if (['host', 'container'].some(mode => [flagValue(args, '--network'), flagValue(args, '--pid'), flagValue(args, '--ipc')].some(v => v?.split(':')[0] === mode))) this.refuse('fixture host or borrowed namespaces forbidden');
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
      if (c.Mounts?.length) this.refuse('fixture acquired an unexpected volume');
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
      const result = await this.execute('docker', ['rm', '-f', c.Id], { ...options, allowFail: false });
      delete state.containers[name]; this.save(state);
      return result;
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
    return Object.freeze({ namespace, namespaceUid: ns.metadata.uid, podName, podUid: pod.metadata.uid, podResourceVersion: pod.metadata.resourceVersion,
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
    return this.withOperation(() => this.execContainerOperation(target, command, options));
  }
  async execContainerOperation(target, command, options = {}) {
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
    return this.withOperation(() => this.spawnContainerOperation(target, command));
  }
  async spawnContainerOperation(target, command) {
    await this.inspectContainer(target);
    const child = this.spawnProcess('docker', ['exec', '-i', target.nodeID, 'crictl', 'exec', '-i', target.containerID, ...command],
      { env: { ...this.env, KUBECONFIG: this.verifiedKubeconfig(), LAB_N2_PINNED_CONFIG: this.pinnedConfig }, stdio: ['pipe', 'pipe', 'pipe'] });
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
  async addRoute(name, address, gateway) {
    return this.withOperation(() => this.addRouteOperation(name, address, gateway));
  }
  async addRouteOperation(name, address, gateway) {
    if (!['169.254.169.254', '169.254.170.2', 'fd00:ec2::254'].includes(address)
      || !isIP(gateway) || isIP(address) !== isIP(gateway)) this.refuse('unsupported IMDS route');
    const state = await this.assertIdentity();
    const fixture = `${this.cluster}-fx-imds`, id = state.containers[fixture];
    if (!id) this.refuse('IMDS fixture creation receipt missing');
    const actual = JSON.parse((await this.execute('docker', ['inspect', id])).stdout)[0];
    const network = actual?.NetworkSettings?.Networks?.kind;
    if (actual?.Id !== id || actual.Config?.Labels?.[n2RunLabel] !== state.runId || actual.Config?.Labels?.[n2LabLabel] !== 'n2'
      || ![network?.IPAddress, network?.GlobalIPv6Address].includes(gateway)) this.refuse('IMDS route gateway is not the owned fixture');
    const node = await this.proveNode(name, state);
    const result = await this.execute('docker', ['exec', node.id, 'ip', ...(isIP(address) === 6 ? ['-6'] : []),
      'route', 'replace', `${address}/${isIP(address) === 6 ? 128 : 32}`, 'via', gateway]);
    await this.proveNode(name, state);
    return result;
  }
  async nodeClock(name) {
    const before = await this.nodeRead(name, ['date', '+%s%3N']);
    const uptime = await this.nodeRead(name, ['cat', '/proc/uptime']);
    const after = await this.nodeRead(name, ['date', '+%s%3N']);
    return { code: 0, stdout: [before.stdout.trim(), uptime.stdout.trim(), after.stdout.trim()].join('\n'), stderr: '' };
  }
  async collectorProbe(name, target) {
    if (target.container !== 'collector') this.refuse('collector capability required');
    await this.inspectContainer(target);
    const pod = await this.get('pod', target.podName, target.namespace);
    const ip = pod.status?.podIP;
    if (!isIP(ip)) this.refuse('collector pod IP missing');
    const state = await this.assertIdentity(), node = await this.proveNode(name, state);
    await this.inspectContainer(target);
    // Ports and command are fixed; only a parsed IP from the proved collector pod becomes an argument.
    const script = `for p in 8080 9598; do (timeout 3 bash -c 'exec 3<>/dev/tcp/$1/$2' sh "$1" "$p") 2>/dev/null && echo "$p open" || echo "$p refused"; done`;
    const result = await this.execute('docker', ['exec', node.id, 'bash', '-c', script, 'sh', ip]);
    await this.validateContainer(target);
    await this.proveNode(name, state);
    return result;
  }
  async exitTargets(namespace, podName, ids) {
    const targets = {};
    for (const [name, id] of Object.entries(ids)) {
      const target = await this.containerTarget(namespace, podName, name);
      if (id !== target.containerID) this.refuse('exit observer container changed');
      await this.inspectContainer(target);
      this.exitBindings.add(target);
      targets[name] = target;
    }
    if (!Object.keys(targets).length) this.refuse('exit observer requires containers');
    return Object.freeze(targets);
  }
  async watchContainerExits(targets, timeoutS) {
    if (!Number.isInteger(timeoutS) || timeoutS < 1 || timeoutS > 180 || !Object.keys(targets).length) this.refuse('invalid exit observer');
    if (Object.values(targets).some(target => !this.exitBindings.has(target))) this.refuse('exit observer lacks a bound container capability');
    // Bound before deletion. Afterwards this read-only observer may inspect the same CRI IDs even when the pod is gone.
    const deadline = Date.now() + timeoutS * 1000;
    let stdout = '';
    do {
      const state = await this.assertIdentity();
      let allExited = true; stdout = '';
      for (const target of Object.values(targets)) {
        if (!/^[a-f0-9]{64}$/.test(target.containerID)) this.refuse('invalid exit container ID');
        await this.ownedNamespace(target.namespace, state);
        const node = await this.proveNode(target.node, state);
        if (node.id !== target.nodeID || node.nodeUid !== target.nodeUid) this.refuse('exit observer node changed');
        const result = await this.execute('docker', ['exec', node.id, 'crictl', 'inspect', '--output', 'json', target.containerID], { allowFail: true });
        if (result.code !== 0) { allExited = false; stdout += `${target.containerID} GONE\n`; continue; }
        const status = JSON.parse(result.stdout).status, labels = status?.labels;
        if (status?.id !== target.containerID || status.metadata?.name !== target.container
          || labels?.['io.kubernetes.pod.uid'] !== target.podUid || labels?.['io.kubernetes.pod.namespace'] !== target.namespace
          || labels?.['io.kubernetes.pod.name'] !== target.podName) this.refuse('exit observer CRI identity changed');
        allExited &&= status.state === 'CONTAINER_EXITED';
        stdout += `${target.containerID} ${status.state} ${status.finishedAt} ${status.exitCode}\n`;
      }
      if (allExited) return { code: 0, stdout, stderr: '' };
      if (Date.now() < deadline) await sleep(50);
    } while (Date.now() < deadline);
    return { code: 3, stdout, stderr: '' };
  }
  async podFile(target, volume, file) {
    if (!({ 'kong-version': ['version'], 'isolation-handoff': ['applied.json', 'admission.jws'] }[volume] ?? []).includes(file)) this.refuse('unsupported pod volume file');
    const info = await this.inspectContainer(target);
    const pod = await this.get('pod', target.podName, target.namespace);
    const container = [...(pod.spec.initContainers ?? []), ...(pod.spec.containers ?? [])].find(c => c.name === target.container);
    const mount = container?.volumeMounts?.find(m => m.name === volume);
    const source = `/var/lib/kubelet/pods/${target.podUid}/volumes/kubernetes.io~empty-dir/${volume}`;
    if (!pod.spec.volumes?.some(v => v.name === volume && v.emptyDir) || !mount || mount.subPath || mount.subPathExpr
      || !info.info?.runtimeSpec?.mounts?.some(m => m.destination === mount.mountPath && m.source === source)) this.refuse('pod volume runtime binding missing');
    await this.inspectContainer(target);
    return `${source}/${file}`;
  }
  async readPodFile(target, volume, file, options = {}) {
    const path = await this.podFile(target, volume, file);
    const result = await this.execute('docker', ['exec', target.nodeID, 'cat', '--', path], options);
    await this.validateContainer(target);
    return result;
  }
  async writePodFile(target, volume, file, input) {
    return this.withOperation(() => this.writePodFileOperation(target, volume, file, input));
  }
  async writePodFileOperation(target, volume, file, input) {
    if (volume !== 'isolation-handoff' || typeof input !== 'string' || Buffer.byteLength(input) > 1024 * 1024) this.refuse('unsupported handoff write');
    const path = await this.podFile(target, volume, file);
    const temporary = `${path}.n2-${randomUUID()}`;
    const script = 'set -eu; test ! -L "$1"; test -f "$1"; (umask 077; set -C; cat > "$2"); chown --reference="$1" "$2"; chmod --reference="$1" "$2"; mv -T -- "$2" "$1"';
    const result = await this.execute('docker', ['exec', '-i', target.nodeID, 'sh', '-c', script, 'sh', path, temporary], { input });
    await this.validateContainer(target);
    return result;
  }
  async signalContainer(target, signal, comm) {
    return this.withOperation(() => this.signalContainerOperation(target, signal, comm));
  }
  async signalContainerOperation(target, signal, comm) {
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
    try { return await this.withOperation(() => this.helmOperation(args, options)); }
    catch (error) { if (error.message?.startsWith('N2 lab refused')) throw error; this.refuse('Helm preflight or mutation failed'); }
  }
  async helmOperation(args, options = {}) {
    this.clusterFlags(args);
    let state = await this.assertIdentity();
    const helm = (argv, opts = options) => this.execute('helm', ['--kubeconfig', this.pinnedConfig, '--kube-context', this.context, ...argv], opts);
    if (['template', 'list', 'status', 'pull'].includes(args[0])) return helm(args);
    if (!['install', 'upgrade'].includes(args[0])) this.refuse('unsupported Helm mutation');
    if (args.some(a => /^(--force|--atomic|--cleanup-on-fail|--take-ownership|--replace)(=|$)/.test(a))) this.refuse('unconditional Helm replacement forbidden');
    const ns = flagValue(args, '-n', '--namespace');
    await this.ownedNamespace(ns, state);
    await this.pvcs(ns, state);
    const release = args.slice(1).find(a => !a.startsWith('-'));
    if (!/^[a-z0-9](?:[a-z0-9-]{0,51}[a-z0-9])?$/.test(release ?? '')) this.refuse('invalid Helm release name');
    const releaseSecrets = async () => JSON.parse((await this.rawK(['get', 'secret', '-n', ns, '-l', `owner=helm,name=${release}`, '-o', 'json'])).stdout).items;
    const initialSecrets = await releaseSecrets();
    for (const secret of initialSecrets) {
      if (!this.owns(secret, state) || state.resources[resourceKey(secret)] !== secret.metadata.uid) this.refuse('preexisting Helm release');
      await this.checkObject(secret, state);
    }
    const versions = initialSecrets.map(o => Number(o.metadata.labels?.version));
    if (versions.some(v => !Number.isSafeInteger(v) || v < 1)) this.refuse('invalid Helm revision inventory');
    const revision = Math.max(0, ...versions) + 1;
    const storageName = `sh.helm.release.v1.${release}.v${revision}`;
    if (await this.get('secret', storageName, ns)) this.refuse('preexisting next Helm storage revision');
    for (const o of state.releases?.[`${ns}/${release}`] ?? []) {
      const existing = await this.get(o.kind, o.metadata.name, o.metadata.namespace);
      if (existing) await this.checkObject(existing, state);
    }
    // Helm does not post-render hooks. Render once up front to prove collisions for the entire chart,
    // then execute its schema Job through the same UID/ownership guard; Helm must never delete hooks by name.
    const rendered = await helm(['template', '--include-crds', ...args.slice(1).filter(a => a !== '--install'), ...(args[0] === 'upgrade' ? ['--is-upgrade'] : [])]);
    const objects = await this.helmObjects(rendered.stdout, ns, state);
    const beforeObjects = new Map();
    for (const o of objects) beforeObjects.set(resourceKey(o), await this.get(o.kind, o.metadata.name, o.metadata.namespace));
    const beforeSecrets = new Map(initialSecrets.map(o => [resourceKey(o), o.metadata.uid]));
    const hooks = objects.filter(o => o.metadata.annotations?.['helm.sh/hook']);
    for (const hook of hooks) {
      if (hook.kind !== 'Job' || !/^(pre-install|pre-upgrade)(,pre-upgrade)?$/.test(hook.metadata.annotations['helm.sh/hook'])) this.refuse('unsupported Helm hook');
    }
    const oldObjects = [];
    for (const o of [...objects, ...(state.releases?.[`${ns}/${release}`] ?? [])]) {
      const existing = await this.get(o.kind, o.metadata.name, o.metadata.namespace);
      if (existing) oldObjects.push(existing);
      else if (this.workload(o)) oldObjects.push(o);
    }
    oldObjects.push(...await releaseSecrets());
    await this.rolloutInventory(oldObjects, state);
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
    await this.assertExclusive(state);
    const helmNamespace = await this.ownedNamespace(ns, state);
    const effects = await this.rolloutInventory(oldObjects, state);
    const beforeUids = new Set([...await this.namespacedResources(), ...await this.clusterResources()].map(o => o.metadata.uid));
    await this.assertExclusive(state);
    if ((await this.ownedNamespace(ns, state)).metadata.uid !== helmNamespace.metadata.uid) this.refuse('Helm namespace changed');
    await this.rolloutInventory(oldObjects, state, 'helm-boundary');
    const result = await helm([...args, '--skip-crds', '--no-hooks', '--post-renderer', process.execPath, '--post-renderer-args', resolve(import.meta.dirname, 'kind-stack-guard.mjs'), '--post-renderer-args', 'n2-helm-render'],
      { ...options, allowFail: false, env: { LAB_HELM_NAMESPACE: ns } });
    if ((await this.ownedNamespace(ns, state)).metadata.uid !== helmNamespace.metadata.uid) this.refuse('Helm namespace changed after write');
    this.rolloutEvidence('helm-after', [...await this.namespacedResources(), ...await this.clusterResources()]);
    state = this.load();
    state.releases ??= {};
    state.releases[`${ns}/${release}`] = objects.filter(o => !hooks.includes(o)).map(o => ({ kind: o.kind, metadata: { name: o.metadata.name, namespace: o.metadata.namespace } }));
    const newStorage = [];
    // The successful Helm create can prove only the exact next revision, absent before the command.
    // Validate its encoded release/manifest as well; arbitrary selector matches never receive labels or receipts.
    for (const secret of await releaseSecrets()) {
      if (beforeSecrets.get(resourceKey(secret)) === secret.metadata.uid) continue;
      if (beforeUids.has(secret.metadata.uid) || secret.metadata.name !== storageName || secret.metadata.namespace !== ns
        || secret.type !== 'helm.sh/release.v1' || secret.metadata.labels?.version !== String(revision)
        || secret.metadata.labels?.owner !== 'helm' || secret.metadata.labels?.name !== release || secret.metadata.labels?.status !== 'deployed')
        this.refuse('unproved new Helm storage Secret; preserve evidence');
      const encoded = Buffer.from(secret.data?.release ?? '', 'base64').toString();
      const stored = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64'), { maxOutputLength: 16 * 1024 * 1024 }).toString());
      if (stored.name !== release || stored.namespace !== ns || stored.version !== revision || stored.info?.status !== 'deployed'
        || typeof stored.manifest !== 'string') this.refuse('Helm storage release identity differs');
      const parsed = JSON.parse((await this.rawK(['create', '--dry-run=client', '-n', ns, '-f', '-', '-o', 'json'], { input: stored.manifest })).stdout);
      const manifest = parsed.kind === 'List' ? parsed.items : [parsed];
      if (this.releaseManifestProof(manifest) !== this.releaseManifestProof(objects.filter(o => !hooks.includes(o) && o.kind !== 'CustomResourceDefinition')))
        this.refuse('Helm storage manifest differs from the proved release');
      newStorage.push(secret);
    }
    if (newStorage.length !== 1) this.refuse('new Helm storage revision was not demonstrated');
    const receipts = [];
    for (const o of objects.filter(o => !hooks.includes(o))) {
      const actual = await this.get(o.kind, o.metadata.name, o.metadata.namespace);
      const previous = beforeObjects.get(resourceKey(o));
      const annotations = actual?.metadata?.annotations;
      const directReceipt = actual && state.resources[resourceKey(actual)] === actual.metadata.uid;
      if (!this.owns(actual, state) || !actual.metadata.uid || (!previous && !directReceipt && beforeUids.has(actual.metadata.uid))
        || (previous ? actual.metadata.uid !== previous.metadata.uid
          : !directReceipt && (annotations?.['meta.helm.sh/release-name'] !== release || annotations?.['meta.helm.sh/release-namespace'] !== ns)))
        this.refuse('Helm resource creation is not demonstrated; preserve evidence');
      receipts.push(actual);
    }
    for (const secret of newStorage) {
      await this.rawK(['label', 'secret', secret.metadata.name, '-n', ns, `${n2LabLabel}=n2`, `${n2RunLabel}=${state.runId}`,
        `--resource-version=${secret.metadata.resourceVersion}`, '--overwrite'], { allowFail: false });
      const actual = await this.get('secret', secret.metadata.name, ns);
      if (!this.owns(actual, state) || actual.metadata.uid !== secret.metadata.uid) this.refuse('Helm storage revision changed');
      receipts.push(actual);
    }
    for (const actual of receipts) {
      this.recordResource(actual, state);
    }
    await this.verifyRollout(effects, state);
    this.save(state);
    return result;
  }
  releaseManifestProof(objects) {
    const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(k => [k, normalize(value[k])])) : value;
    return sha256(JSON.stringify(objects.map(o => {
      const object = structuredClone(o);
      delete object.status;
      for (const field of ['uid', 'resourceVersion', 'managedFields', 'creationTimestamp']) delete object.metadata[field];
      delete object.metadata.annotations?.['meta.helm.sh/release-name'];
      delete object.metadata.annotations?.['meta.helm.sh/release-namespace'];
      delete object.metadata.labels?.['app.kubernetes.io/managed-by'];
      return normalize(object);
    }).sort((a, b) => resourceKey(a).localeCompare(resourceKey(b)))));
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
      this.checkManifestStorage(o, state);
      this.decorate(o, state);
    }
    return objects;
  }
  async image(args) {
    try { return await this.withOperation(() => this.imageOperation(args)); }
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
    return this.withOperation(() => this.pullImageOperation(image));
  }
  async pullImageOperation(image) {
    await this.assertIdentity();
    if (!/@sha256:[0-9a-f]{64}$/.test(image)) this.refuse('pull requires a pinned digest');
    return this.execute('docker', ['pull', '-q', image]);
  }
  async loadImage(image) {
    return this.withOperation(() => this.loadImageOperation(image));
  }
  async loadImageOperation(image) {
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
    if (['ClusterRole', 'ClusterRoleBinding'].includes(o.kind)) return n2SystemAccounts.some(account => name === `system:controller:${account}`)
      || ['admin', 'cluster-admin', 'edit', 'view', 'kubeadm:node-autoapprove-bootstrap', 'kubeadm:node-autoapprove-certificate-rotation',
        'kubeadm:kubelet-bootstrap', 'kubeadm:get-nodes', 'kubeadm:cluster-admins', 'kind:local-path-provisioner',
        'system:aggregate-to-admin', 'system:aggregate-to-edit', 'system:aggregate-to-view', 'system:auth-delegator', 'system:basic-user',
        'system:certificates.k8s.io:certificatesigningrequests:nodeclient', 'system:certificates.k8s.io:certificatesigningrequests:selfnodeclient',
        'system:certificates.k8s.io:kube-apiserver-client-approver', 'system:certificates.k8s.io:kube-apiserver-client-kubelet-approver',
        'system:certificates.k8s.io:kubelet-serving-approver', 'system:certificates.k8s.io:legacy-unknown-approver',
        'system:certificates.k8s.io:kube-apiserver-client-signer', 'system:certificates.k8s.io:kube-apiserver-client-kubelet-signer',
        'system:certificates.k8s.io:kubelet-serving-signer', 'system:certificates.k8s.io:legacy-unknown-signer',
        'system:coredns', 'system:discovery', 'system:heapster', 'system:kube-aggregator', 'system:kube-controller-manager', 'system:kube-dns',
        'system:kube-scheduler', 'system:kubelet-api-admin', 'system:monitoring', 'system:node', 'system:node-bootstrapper',
        'system:node-problem-detector', 'system:node-proxier', 'system:persistent-volume-provisioner', 'system:public-info-viewer',
        'system:service-account-issuer-discovery', 'system:volume-scheduler'].includes(name);
    if (o.kind === 'StorageClass') return name === 'standard' && o.provisioner === 'rancher.io/local-path';
    if (o.kind === 'APIService') return !o.spec?.service && ['v1.', 'v1.admissionregistration.k8s.io', 'v1.apiextensions.k8s.io', 'v1.apps', 'v1.authentication.k8s.io', 'v1.authorization.k8s.io', 'v1.autoscaling', 'v2.autoscaling', 'v1.batch', 'v1.certificates.k8s.io', 'v1.coordination.k8s.io', 'v1.discovery.k8s.io', 'v1.events.k8s.io', 'v1.flowcontrol.apiserver.k8s.io', 'v1.networking.k8s.io', 'v1.node.k8s.io', 'v1.policy', 'v1.rbac.authorization.k8s.io', 'v1.scheduling.k8s.io', 'v1.storage.k8s.io', 'v1.storagemigration.k8s.io', 'v1.resource.k8s.io', 'v1beta1.resource.k8s.io', 'v1beta2.resource.k8s.io'].includes(name);
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
    if (!['kube-system', 'kube-public', 'kube-node-lease', 'default', 'local-path-storage'].includes(namespace)) return false;
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
    if (this.systemCoordination(o, state)) return true;
    if (o.kind === 'ServiceAccount' && name === 'default') return true;
    if (namespace === 'default') return ['Service', 'Endpoints'].includes(o.kind) && name === 'kubernetes';
    if (o.kind === 'ConfigMap' && name === 'kube-root-ca.crt') return true;
    if (namespace === 'kube-public') return o.kind === 'ConfigMap' && name === 'cluster-info';
    if (namespace === 'local-path-storage') return ({ Deployment: ['local-path-provisioner'], ServiceAccount: ['local-path-provisioner-service-account'], ConfigMap: ['local-path-config'], Role: ['local-path-provisioner-role'], RoleBinding: ['local-path-provisioner-bind'] }[o.kind] ?? []).includes(name);
    if (namespace !== 'kube-system') return false;
    const known = { ConfigMap: ['coredns', 'kube-proxy', 'kubeadm-config', 'kubelet-config', 'extension-apiserver-authentication'],
      Deployment: ['coredns'], DaemonSet: ['kube-proxy'], Service: ['kube-dns'], Role: ['extension-apiserver-authentication-reader', 'system:controller:bootstrap-signer', 'system:controller:token-cleaner', 'system::leader-locking-kube-controller-manager', 'system::leader-locking-kube-scheduler', 'kubeadm:kubelet-config', 'kube-proxy'],
      RoleBinding: ['kubeadm:kubelet-config', 'kube-proxy', 'system::extension-apiserver-authentication-reader', 'system::leader-locking-kube-controller-manager', 'system::leader-locking-kube-scheduler', 'system:controller:bootstrap-signer', 'system:controller:token-cleaner'],
      ServiceAccount: ['default', ...n2SystemAccounts] };
    return known[o.kind]?.includes(name) === true;
  }
  baselineProof(o) {
    const value = structuredClone(o);
    delete value.status;
    delete value.metadata.resourceVersion;
    delete value.metadata.managedFields;
    delete value.metadata.annotations?.['deployment.kubernetes.io/revision'];
    if (this.systemCoordination(o)) {
      for (const key of ['renewTime', 'acquireTime', 'leaseTransitions']) delete value.spec?.[key];
    }
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
      if (this.expectedGenerated(o, state, objects)) continue;
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
  if (command === 'n2-name') {
    if (!/^[a-z0-9-]{12,63}$/.test(process.env.LAB_RUN_ID ?? '')) lab.refuse('LAB_RUN_ID required');
    console.log(lab.cluster);
  } else if (command === 'n2-create') await lab.createCluster(readFileSync(0, 'utf8'));
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
