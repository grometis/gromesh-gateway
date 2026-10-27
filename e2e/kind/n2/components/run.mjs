#!/usr/bin/env node
// N2 admission suite with the real components (W0 items q, and what does not depend on a serving pod) on the N2 lab:
// the control plane built from main (with its own Postgres), the data plane chart in Workspaces mode with the real
// agent and isolation-probe, the probe's targets being the N2-E1 fixtures behind the protected policies.
//   LAB_KUBECONFIG=<file> [LAB_CLUSTER_SH=<e2e/kind/n2/cluster.sh>] [LAB_OUT=<dir>] node e2e/kind/n2/components/run.mjs
// Images (loaded beforehand into the nodes that run them): CP_IMAGE, AGENT_IMAGE, KONG_IMAGE (repo:tag), PG_IMAGE.
// Known limit: until N3 the agent applies the v1 snapshot, so the guard canary never answers and every pod ends in
// guard-missing (Kong stopped, fail-closed). The acceptances that need a serving pod depend on N3 and are not here.
import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import {
  Api, apply, assertLab, CONTEXT, controlPlaneObjects, cpSecrets, dbSkew, denyPolicies, docker, Forward, helm, json, kubeconfig, kubectl, NS, root, sql,
} from "./lab.mjs";

const out = process.env.LAB_OUT ?? mkdtempSync(join(tmpdir(), "gromesh-n2-comp-"));
const IMAGES = {
  cp: process.env.CP_IMAGE ?? "gromesh-n2c-cp:30a0056",
  agent: process.env.AGENT_IMAGE ?? "gromesh-n2c-agent:30a0056",
  kong: process.env.KONG_IMAGE ?? "gromesh-n2c-kong:786d736c",
  pg: process.env.PG_IMAGE ?? "postgres:16-alpine",
};
const CHART = join(root, "deploy/helm/data-plane");
const SELECTOR = "app.kubernetes.io/name=data-plane,app.kubernetes.io/instance=dp";
// agent-protocol-v2 and the control plane's timers.
const P = 15_000, T = 3_000, S = 1_000, AGENT_INTERVAL = 2_000, DECISION = 45_000, COMMUNICATION = 60_000, UNCONFIRMED = 600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const report = { startedAt: new Date().toISOString(), images: IMAGES, context: CONTEXT, items: [], findings: [], timeline: [] };
const save = () => writeFileSync(join(out, "results.json"), JSON.stringify(report, null, 2));
const log = (message) => console.log(`${new Date().toISOString()} ${message}`);
const mark = (event, data = {}) => { report.timeline.push({ at: new Date().toISOString(), event, ...data }); log(`${event} ${JSON.stringify(data)}`); };

function item(id, title, budget) {
  const it = { id, title, budget, result: "pending", measures: {}, negative: [], failures: [], notes: [] };
  report.items.push(it);
  log(`--- item ${id}: ${title}`);
  return it;
}
const expect = (it, ok, message) => { if (!ok) it.failures.push(message); return ok; };
/** A negative control: the protection must refuse; `ok` says whether it did. */
const negative = (it, what, expected, observed, ok) => { it.negative.push({ what, expected, observed, ok }); if (!ok) it.failures.push(`negative control "${what}": expected ${expected}, observed ${observed}`); };
function done(it) {
  it.result = it.failures.length ? "fail" : "pass";
  save();
  log(`item ${it.id}: ${it.result.toUpperCase()} ${JSON.stringify(it.measures)}`);
  for (const f of it.failures) log(`  ${f}`);
}

async function waitFor(what, fn, { timeoutMs = 60_000, intervalMs = 1000 } = {}) {
  const began = Date.now();
  for (;;) {
    const value = await fn().catch((error) => { if (Date.now() - began > timeoutMs) throw error; return undefined; });
    if (value) return value;
    if (Date.now() - began > timeoutMs) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await sleep(intervalMs);
  }
}

// --- lab topology and the probe's targets -------------------------------------------------------------------------
async function topology() {
  const nodes = (await json(["get", "nodes"])).items.map((n) => {
    const ips = n.status.addresses.filter((a) => a.type === "InternalIP").map((a) => a.address);
    return { name: n.metadata.name, v4: ips.find((ip) => !ip.includes(":")), v6: ips.find((ip) => ip.includes(":")) };
  });
  const fixture = async (role) => {
    const [c] = JSON.parse((await docker(["inspect", `gromesh-n2-lab-fx-${role}`])).stdout);
    if (!c?.State?.Running) throw new Error(`N2-E1 fixture ${role} is not running: run e2e/kind/n2/run.mjs first`);
    const n = c.NetworkSettings.Networks.kind;
    return { v4: n.IPAddress, v6: n.GlobalIPv6Address };
  };
  const ext = { backend: await fixture("backend"), nodecidr: await fixture("nodecidr"), denied: await fixture("denied"), imds: await fixture("imds") };
  const podIps = async (name) => {
    const p = await json(["-n", NS.fx, "get", "pod", name]);
    if (p.status.phase !== "Running") throw new Error(`N2-E1 fixture pod ${name} is ${p.status.phase}`);
    const ips = p.status.podIPs.map((x) => x.ip);
    return { v4: ips.find((ip) => !ip.includes(":")), v6: ips.find((ip) => ip.includes(":")) };
  };
  const fx = { outsideSame: await podIps("outside-same"), outsideOther: await podIps("outside-other") };
  const v4net = ext.backend.v4.split(".").slice(0, 3).join(".");
  const v6net = ext.backend.v6.slice(0, ext.backend.v6.lastIndexOf(":") - 1);
  // The same declared ranges as N2-E1: nodeCidrs cover where Docker places the kind nodes, deniedCidrs the .192/27.
  const net = { nodeCidrs: [`${v4net}.0/26`, `${v6net}::/122`], deniedCidrs: [`${v4net}.192/27`, `${v6net}::c0/123`] };
  return { nodes, ext, fx, net };
}

const hostPort = (ip, port) => (ip.includes(":") ? `[${ip}]:${port}` : `${ip}:${port}`);

/** The probe's configuration: every capability with forbidden targets from the lab, and the positive controls. */
function probeChecks(topo) {
  const checks = [];
  const tcp = (capability, name, address) => checks.push({ capability, kind: "tcp", name, address });
  for (const [label, pair] of [["same node as the fixtures' resident", topo.fx.outsideSame], ["other node", topo.fx.outsideOther]]) {
    tcp("CAP-1", `pod outside the list (${label}) v4`, hostPort(pair.v4, 8080));
    tcp("CAP-1", `pod outside the list (${label}) v6`, hostPort(pair.v6, 8080));
  }
  tcp("CAP-1", "service outside the list", `outside-other.${NS.fx}.svc.cluster.local:8080`);
  for (const n of topo.nodes) {
    tcp("CAP-2", `node ${n.name} hostNetwork v4`, hostPort(n.v4, 18080));
    tcp("CAP-2", `node ${n.name} hostNetwork v6`, hostPort(n.v6, 18080));
    tcp("CAP-2", `node ${n.name} kubelet`, hostPort(n.v4, 10250));
  }
  for (const [label, pair] of [["declared nodeCidrs", topo.ext.nodecidr], ["declared deniedCidrs", topo.ext.denied]]) {
    tcp("CAP-2", `${label} v4`, hostPort(pair.v4, 8080));
    tcp("CAP-2", `${label} v6`, hostPort(pair.v6, 8080));
  }
  for (const ip of ["169.254.169.254", "169.254.170.2", "fd00:ec2::254"]) tcp("CAP-3", `metadata ${ip}`, hostPort(ip, 80));
  tcp("CAP-3", "metadata by name", "imds.lab.gromesh.test:80");
  tcp("CAP-4", "name resolving to a node", "node.lab.gromesh.test:18080");
  checks.push({ capability: "CAP-4", kind: "dns", name: "lab zone", host: "backend.lab.gromesh.test" });
  checks.push({ capability: "CAP-4", kind: "dns", name: "cluster dns", host: `outside-other.${NS.fx}.svc.cluster.local` });
  checks.push({ capability: "CAP-1", kind: "tcp-open", name: "allowed backend v4", address: hostPort(topo.ext.backend.v4, 8080) });
  checks.push({ capability: "CAP-1", kind: "tcp-open", name: "allowed backend v6", address: hostPort(topo.ext.backend.v6, 8080) });
  tcp("CAP-5", "control plane database", `postgres.${NS.cp}.svc.cluster.local:5432`);
  checks.push({ capability: "CAP-6", kind: "http", name: "agent metrics from its own pod", url: "http://127.0.0.1:9100/metrics", expectStatus: 403 });
  checks.push({ capability: "CAP-7", kind: "http", name: "collector on loopback", url: "http://127.0.0.1:9880/", expectStatus: 401 });
  return checks;
}

/** Every forbidden target the probe tries must be live from the unrestricted N2-E1 observer: unreachable is never mere absence. */
async function liveness(checks) {
  const targets = checks.filter((c) => c.kind === "tcp").map((c, i) => {
    const at = c.address.lastIndexOf(":");
    const host = c.address.slice(0, at).replace(/^\[|\]$/g, "");
    const port = Number(c.address.slice(at + 1));
    const handshake = port === 10250 || port === 5432;
    return { id: `${i}:${c.name}`, cap: c.capability, ...(/^[0-9.]+$|:/.test(host) ? { ip: host } : { name: host, family: 4 }), port, expect: "reach", ...(handshake ? { proof: "handshake" } : {}) };
  });
  const { stdout } = await kubectl(["-n", NS.fx, "exec", "-i", "observer", "--", "node", "/lab/fixtures.mjs", "probe"], { input: JSON.stringify(targets), timeout: 60_000 });
  return JSON.parse(stdout).map((r) => ({ id: r.id, verdict: r.verdict, outcomes: r.results?.map((x) => x.outcome) ?? [r.outcome] }));
}

// --- data plane pods ----------------------------------------------------------------------------------------------
async function pods() {
  const list = await json(["-n", NS.dp, "get", "pods", "-l", SELECTOR]);
  return list.items.map((p) => ({
    name: p.metadata.name, uid: p.metadata.uid, node: p.spec.nodeName, phase: p.status.phase, deleting: Boolean(p.metadata.deletionTimestamp),
    created: Date.parse(p.metadata.creationTimestamp),
    containers: Object.fromEntries([...(p.status.initContainerStatuses ?? []), ...(p.status.containerStatuses ?? [])].map((s) => [s.name, s])),
  }));
}
const live = async () => (await pods()).filter((p) => !p.deleting);
const newPod = (known) => waitFor("a new data plane pod", async () => (await live()).find((p) => !known.has(p.uid)), { timeoutMs: 90_000 });

/** Kong container samples: nginx processes and kong-supervisor's state, each with the interval it was taken in. */
class NginxSampler {
  constructor(pod) { this.pod = pod; this.samples = []; this.running = false; }
  start() {
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        const start = Date.now();
        const r = await kubectl(["-n", NS.dp, "exec", this.pod, "-c", "kong", "--", "sh", "-c",
          `printf '%s ' "$(cat /proc/[0-9]*/comm 2>/dev/null | grep -c '^nginx$')"; cat /gromesh/kong-state/kong-state.json 2>/dev/null || true`], { allowFail: true, timeout: 10_000 });
        const end = Date.now();
        if (r.code === 0) {
          const [count, ...rest] = r.stdout.trim().split(" ");
          let state = null;
          try { state = JSON.parse(rest.join(" ")); } catch { /* not written yet */ }
          this.samples.push({ start, end, nginx: Number(count), nginxState: state?.nginx ?? null });
        }
        await sleep(Math.max(0, 300 - (Date.now() - start)));
      }
    })();
  }
  async stop() { this.running = false; await this.loop; }
}

/** kubectl logs --timestamps, followed: survives the pod's deletion with every line it printed. */
class Follower {
  constructor(pod, container) {
    this.lines = [];
    this.child = spawn("kubectl", ["--kubeconfig", kubeconfig, "--context", CONTEXT, "-n", NS.dp, "logs", "-f", "--timestamps", pod, "-c", container], { stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    this.child.stdout.on("data", (d) => {
      buffer += d;
      const parts = buffer.split("\n");
      buffer = parts.pop();
      for (const line of parts) this.lines.push(parseLine(line));
    });
    this.closed = new Promise((resolve) => this.child.on("close", resolve));
  }
  stop() { this.child.kill("SIGKILL"); }
}
function parseLine(line) {
  const space = line.indexOf(" ");
  const stamp = line.slice(0, space);
  // RFC 3339 with nanoseconds: kept to the millisecond.
  const at = Date.parse(stamp.replace(/(\.\d{3})\d*Z$/, "$1Z"));
  return { at, text: line.slice(space + 1) };
}
async function logs(pod, container) {
  const { stdout } = await kubectl(["-n", NS.dp, "logs", "--timestamps", pod, "-c", container], { allowFail: true });
  return stdout.split("\n").filter(Boolean).map(parseLine);
}
const firstLine = (lines, pattern) => lines.find((l) => pattern.test(l.text));

/** The host pid of a container of a data plane pod, checked against the binary it must be. */
async function containerPid(podName, container, comm) {
  const p = await json(["-n", NS.dp, "get", "pod", podName]);
  const st = [...(p.status.initContainerStatuses ?? []), ...(p.status.containerStatuses ?? [])].find((s) => s.name === container);
  const id = st.containerID.replace(/^containerd:\/\//, "");
  const pid = Number((await docker(["exec", p.spec.nodeName, "crictl", "inspect", "-o", "go-template", "--template", "{{.info.pid}}", id])).stdout.trim());
  const actual = (await docker(["exec", p.spec.nodeName, "cat", `/proc/${pid}/comm`])).stdout.trim();
  if (actual !== comm) throw new Error(`pid ${pid} of ${podName}/${container} is ${actual}, not ${comm}`);
  return { node: p.spec.nodeName, pid };
}

// --- control plane state ------------------------------------------------------------------------------------------
let skew = 0;
const local = (dbMs) => (dbMs == null ? null : Number(dbMs) - skew);
const ms = (column) => `(extract(epoch from ${column}) * 1000)::bigint`;

async function admissions(clusterId) {
  if (!UUID.test(clusterId)) throw new Error("bad cluster id");
  const rows = await sql(`select id, pod_uid, pod_name, node_name, outcome, reason, admission_id, kid, state, close_reason, acked_seq, challenge, challenge_seq, last_state,
    ${ms("requested_at")} as requested, ${ms("decided_at")} as decided, ${ms("closed_at")} as closed, ${ms("last_report_at")} as last_report
    from isolation_admissions where cluster_id = '${clusterId}' order by requested_at, id`);
  return rows.map((r) => ({ ...r, requested: local(r.requested), decided: local(r.decided), closed: local(r.closed), last_report: local(r.last_report) }));
}
async function reports(admissionId) {
  if (!UUID.test(admissionId)) throw new Error("bad admission id");
  const rows = await sql(`select seq, protected, payload, signature, digest, prev_digest, state, challenge, final, final_reason, kong_stop_confirmed, ${ms("received_at")} as received
    from isolation_reports where admission_id = '${admissionId}' order by seq`);
  return rows.map((r) => ({ ...r, received: local(r.received) }));
}
async function pendencies(clusterId) {
  const rows = await sql(`select id, lifecycle, kind, scope, admission_id, pod_uid, capability, close_reason, justification, released_by, ${ms("opened_at")} as opened, ${ms("closed_at")} as closed
    from isolation_pendencies where cluster_id = '${clusterId}' order by opened_at, id`);
  return rows.map((r) => ({ ...r, opened: local(r.opened), closed: local(r.closed) }));
}
const admissionOf = async (clusterId, podUid) => (await admissions(clusterId)).filter((a) => a.pod_uid === podUid);
const grantedOf = async (clusterId, podUid) => (await admissionOf(clusterId, podUid)).find((a) => a.outcome === "granted");

/** The chain as the control plane stored it: seq without gaps, prevDigest the sha256 of the previous payload bytes, every
 * report verified with the probe key bound to the admission. `wrongDigest` hashes the whole JWS (the instrument's control). */
function chainProblems(rows, probePublicKey, { wrongDigest = false } = {}) {
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: probePublicKey }, format: "jwk" });
  const problems = [];
  let previous = null;
  for (const r of rows) {
    if (!verify(null, Buffer.from(`${r.protected}.${r.payload}`), key, Buffer.from(r.signature, "base64url"))) problems.push(`seq ${r.seq}: signature`);
    if (Buffer.from(r.protected, "base64url").toString() !== '{"alg":"EdDSA","typ":"gromesh-probe-report+json"}') problems.push(`seq ${r.seq}: header`);
    const payload = Buffer.from(r.payload, "base64url");
    const claims = JSON.parse(payload);
    if (claims.seq !== r.seq) problems.push(`seq ${r.seq}: payload seq ${claims.seq}`);
    if (previous && r.seq !== previous.seq + 1) problems.push(`seq ${r.seq} after ${previous.seq}`);
    if (!previous && r.seq !== 1) problems.push(`chain starts at ${r.seq}`);
    const want = previous ? `sha256:${createHash("sha256").update(wrongDigest ? JSON.stringify(previous.row) : previous.payload).digest("hex")}` : null;
    if ((claims.prevDigest ?? null) !== want) problems.push(`seq ${r.seq}: prevDigest ${claims.prevDigest}, want ${want}`);
    previous = { seq: r.seq, payload, row: { protected: r.protected, payload: r.payload, signature: r.signature } };
  }
  return problems;
}

// --- main ---------------------------------------------------------------------------------------------------------
const ctx = {};
const followers = [];

async function setup() {
  const it = item("1", "Postgres + control plane from main; admin, instance signing key (session+CSRF), cluster, registration token; data plane chart in Workspaces mode", { note: "setup" });
  report.environment = await assertLab();
  const topo = await topology();
  ctx.topo = topo;
  report.topology = topo;
  mark("topology", { nodes: topo.nodes.map((n) => n.name) });

  // A fresh, reproducible start: only this suite's namespaces and its own cluster-wide policies are removed.
  await kubectl(["delete", "namespace", NS.dp, NS.cp, "--ignore-not-found", "--wait", "--timeout=240s"], { timeout: 260_000 });
  await kubectl(["delete", "ciliumclusterwidenetworkpolicy", "n2c-deny-host", "n2c-deny-imds", "n2c-deny-cidrs", "--ignore-not-found"]);

  const secrets = cpSecrets();
  ctx.secrets = secrets;
  await apply(controlPlaneObjects(secrets, { cpImage: IMAGES.cp, pgImage: IMAGES.pg }));
  await kubectl(["-n", NS.cp, "rollout", "status", "deployment/postgres", "--timeout=180s"], { timeout: 200_000 });
  await kubectl(["-n", NS.cp, "rollout", "status", "deployment/control-plane", "--timeout=240s"], { timeout: 260_000 });
  ctx.forward = new Forward(Number(process.env.LAB_CP_PORT ?? 39300));
  ctx.api = new Api(ctx.forward);
  await waitFor("control plane /healthz", async () => (await ctx.api.req("GET", "/healthz")).status === 200, { timeoutMs: 120_000 });
  skew = (await dbSkew()).skew;
  report.dbSkewMs = skew;
  mark("control plane up", { dbSkewMs: Math.round(skew) });
  const cpPod = (await json(["-n", NS.cp, "get", "pods", "-l", "app=control-plane"])).items[0];
  it.measures.controlPlaneImageId = cpPod.status.containerStatuses[0].imageID;

  const { api } = ctx;
  const admin = await api.login(secrets.admin.email, secrets.admin.password);
  ctx.admin = admin;
  await api.ok("POST", "/api/v1/users", { session: admin, body: { email: secrets.editor.email, name: "Editor do lab", role: "editor", password: secrets.editor.password } });
  ctx.editor = await api.login(secrets.editor.email, secrets.editor.password);
  ctx.adminToken = (await api.ok("POST", "/api/v1/users/me/tokens", { session: admin, body: { name: "n2-lab-admin", role: "admin", expiresInDays: 1 } })).token;
  ctx.editorToken = (await api.ok("POST", "/api/v1/users/me/tokens", { session: ctx.editor, body: { name: "n2-lab-editor", role: "editor", expiresInDays: 1 } })).token;
  const envRow = await api.ok("POST", "/api/v1/environments", { session: admin, body: { name: "n2-lab" } });
  const cluster = await api.ok("POST", `/api/v1/environments/${envRow.id}/clusters`, { session: admin, body: { name: "n2-lab-dp" } });
  ctx.clusterId = cluster.id;
  ctx.registrationToken = cluster.registrationToken;
  it.measures.clusterId = cluster.id;

  // The instance key: only a session with its CSRF token creates one.
  const validUntil = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const byToken = await api.req("POST", "/api/v2/instance/signing-keys", { token: ctx.adminToken, body: { validUntil } });
  // A session-only operation answers 401 to an API token ("requires a session"); the contract allows 401 and 403.
  negative(it, "create the instance signing key with the admin's API token", "401 or 403", byToken.status, [401, 403].includes(byToken.status));
  const noCsrf = await api.req("POST", "/api/v2/instance/signing-keys", { session: admin, csrf: false, body: { validUntil } });
  negative(it, "create the instance signing key with the admin session without CSRF", 403, noCsrf.status, noCsrf.status === 403);
  const byEditor = await api.req("POST", "/api/v2/instance/signing-keys", { session: ctx.editor, body: { validUntil } });
  negative(it, "create the instance signing key as editor (session+CSRF)", 403, byEditor.status, byEditor.status === 403);
  const k1 = await api.ok("POST", "/api/v2/instance/signing-keys", { session: admin, body: { validUntil } });
  const listed = await api.ok("GET", "/api/v2/instance/signing-keys", { session: admin });
  expect(it, listed.items.some((k) => k.kid === k1.kid && k.publicKey === k1.publicKey && k.status === "active"), "the new key is not listed active");
  expect(it, createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${k1.publicKey}"}`).digest("base64url") === k1.kid, "kid is not the RFC 7638 thumbprint");
  ctx.k1 = { kid: k1.kid, publicKey: k1.publicKey };
  it.measures.k1 = ctx.k1;

  // The probe's targets: each forbidden one live from the unrestricted observer.
  const checks = probeChecks(topo);
  ctx.checks = checks;
  const alive = await liveness(checks);
  const dead = alive.filter((r) => r.verdict !== "pass");
  it.measures.forbiddenTargetsLive = `${alive.length - dead.length}/${alive.length}`;
  expect(it, dead.length === 0, `forbidden targets not live from the observer: ${dead.map((d) => `${d.id}=${d.outcomes}`).join("; ")}`);

  await apply([{ apiVersion: "v1", kind: "Namespace", metadata: { name: NS.dp } }, ...denyPolicies(topo.net)]);
  ctx.values = (keys, replicas = 1) => ({
    replicaCount: replicas,
    kong: { image: { repository: IMAGES.kong.split(":")[0], tag: IMAGES.kong.split(":")[1], digest: "", pullPolicy: "Never" } },
    agent: { image: { repository: IMAGES.agent.split(":")[0], tag: IMAGES.agent.split(":")[1], digest: "", pullPolicy: "Never" },
      controlPlaneUrl: `http://control-plane.${NS.cp}.svc.cluster.local:3000`, token: ctx.registrationToken },
    networkPolicy: {
      enabled: true,
      controlPlanePeers: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": NS.cp } }, podSelector: { matchLabels: { app: "control-plane" } } }],
      upstreams: [{ cidr: `${topo.ext.backend.v4}/32`, ports: [8080] }, { cidr: `${topo.ext.backend.v6}/128`, ports: [8080] }],
    },
    workspaces: { enabled: true, clusterId: ctx.clusterId, instanceSigningKeys: keys, probe: { checks } },
  });
  ctx.helmValues = async (keys, replicas) => {
    const file = join(out, `values-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(ctx.values(keys, replicas)), { mode: 0o600 });
    return file;
  };
  done(it);
}

/** Item 2: cold start, awaiting-admission → admission granted by the real CP, adopted by the real probe; no nginx before it. */
async function coldStart() {
  const it = item("2", "Cold start: awaiting-admission → admission granted by the CP, verified by the probe; no nginx before the grant", {
    decision: `request → grant ≤ ${DECISION / 1000} s (no timeout grants)`, start: `grant → nginx ≤ P + T + S = ${(P + T + S) / 1000} s`, nginxBeforeGrant: "0" });
  const t0 = Date.now();
  await helm(["install", "dp", CHART, "-n", NS.dp, "-f", await ctx.helmValues([ctx.k1], 1)]);
  mark("helm install", { replicas: 1 });
  const pod = await newPod(new Set());
  const sampler = new NginxSampler(pod.name);
  sampler.start();
  ctx.p1 = pod;
  try {
    const granted = await waitFor("pod 1 admission granted", () => grantedOf(ctx.clusterId, pod.uid), { timeoutMs: 180_000 }).catch(() => null);
    if (!granted) {
      // No admission: what the components did meanwhile, without working around any of them.
      await sampler.stop();
      const agentLogs = await logs(pod.name, "agent");
      const probeLogs = await logs(pod.name, "isolation-probe");
      const [{ n: nodes }] = await sql(`select count(*)::int as n from cluster_nodes where cluster_id = '${ctx.clusterId}'`);
      const requests = await admissionOf(ctx.clusterId, pod.uid);
      const registrationFailures = agentLogs.filter((l) => /registration failed/.test(l.text));
      Object.assign(it.measures, {
        waitedMs: Date.now() - t0, registeredNodes: nodes, admissionRequests: requests.length,
        agentRegistrationFailures: registrationFailures.length, agentLastError: registrationFailures.at(-1)?.text,
        probeLog: probeLogs.map((l) => l.text), samples: sampler.samples.length, nginxInAnySample: sampler.samples.filter((s) => s.nginx > 0).length,
      });
      expect(it, false, `no admission within 180 s: ${nodes} registered nodes, ${requests.length} admission requests`);
      expect(it, sampler.samples.every((s) => s.nginx === 0), "nginx ran without an admission");
      if (nodes === 0 && registrationFailures.some((l) => /read Kong version/.test(l.text))) {
        ctx.blocked = "F1: the agent never registers in Workspaces mode (it reads Kong's version from the Admin API, which only exists once an admission let nginx start), so it never asks for an admission";
        report.findings.push({ id: "F1", item: "2", blocking: true, evidence: it.measures });
      }
      return;
    }
    await waitFor("nginx observed in pod 1", async () => sampler.samples.some((s) => s.nginx > 0), { timeoutMs: P + T + S + 30_000, intervalMs: 300 });
    await sleep(500);
    await sampler.stop();
    const all = await admissionOf(ctx.clusterId, pod.uid);
    const [p] = (await pods()).filter((x) => x.uid === pod.uid);
    const kongLogs = await logs(pod.name, "kong");
    const probeLogs = await logs(pod.name, "isolation-probe");
    const nginxStart = firstLine(kongLogs, /lease valid: nginx started/);
    const admitted = firstLine(probeLogs, /admitted: /);
    const firstNginx = sampler.samples.find((s) => s.nginx > 0);
    const before = sampler.samples.filter((s) => s.end < granted.decided);
    const startedBefore = sampler.samples.filter((s) => s.start < granted.decided && s.nginx > 0);
    const kongStarted = Date.parse(p.containers.kong?.state?.running?.startedAt ?? p.containers.kong?.lastState?.terminated?.startedAt ?? "");
    Object.assign(it.measures, {
      podCreatedToKongStartedMs: kongStarted - pod.created,
      requestToGrantMs: granted.decided - granted.requested,
      requestsBeforeGrant: all.filter((a) => a.requested <= granted.requested).length,
      kongStartedToGrantMs: granted.decided - kongStarted,
      samplesBeforeGrant: before.length,
      nginxInSamplesBeforeGrant: startedBefore.length,
      grantToProbeAdmittedMs: admitted ? admitted.at - granted.decided : null,
      grantToNginxStartedLogMs: nginxStart ? nginxStart.at - granted.decided : null,
      grantToFirstNginxSampleMs: firstNginx.start - granted.decided,
      helmToGrantMs: granted.decided - t0,
      kid: granted.kid,
    });
    expect(it, granted.kid === ctx.k1.kid, `granted with kid ${granted.kid}, expected ${ctx.k1.kid}`);
    expect(it, granted.decided - granted.requested <= DECISION, "grant later than the decision window");
    // The kong container may start less than a sampling interval before the grant (it did, 0.7 s, once registration
    // stopped waiting for Kong): then the supervisor's and the probe's own log order below is the evidence, and the
    // samples only add to it. Without either, nothing was measured.
    expect(it, before.length >= 3 || (nginxStart && admitted), `only ${before.length} samples of the kong container before the grant and no supervisor/probe log order: nothing measured`);
    expect(it, startedBefore.length === 0, `nginx seen before the grant in ${startedBefore.length} samples`);
    expect(it, nginxStart && nginxStart.at >= granted.decided, `kong-supervisor started nginx at ${nginxStart?.at} before the grant at ${granted.decided}`);
    expect(it, admitted && nginxStart && admitted.at <= nginxStart.at, "nginx started before the probe adopted the admission");
    expect(it, nginxStart && nginxStart.at - granted.decided <= P + T + S + 2_000, `grant → nginx ${nginxStart?.at - granted.decided} ms (budget P+T+S + the agent's handoff)`);
    // The instrument's own control: the same sampler does see nginx once the lease is out.
    negative(it, "the sampler sees nginx once the lease exists (instrument control)", "nginx > 0 after the grant", `first nginx sample ${firstNginx.start - granted.decided} ms after the grant`, firstNginx.start >= granted.decided);
    ctx.a1 = granted;
    writeFileSync(join(out, "item2-samples.json"), JSON.stringify(sampler.samples));
  } finally {
    if (sampler.running) await sampler.stop();
    done(it);
  }
}

/** Item 3: the reports reach the CP in order, the ack is the contiguous prefix, as getClusterIsolation shows it. */
async function reportsInOrder() {
  const it = item("3", "Reports reach the CP in order; ack contiguous (getClusterIsolation and the database)", { cadence: `one report per round, P = ${P / 1000} s`, ack: "highest contiguous seq" });
  const a1 = ctx.a1;
  const rows = await waitFor("four acked reports of pod 1", async () => {
    const [a] = (await admissions(ctx.clusterId)).filter((x) => x.admission_id === a1.admission_id);
    return a.acked_seq >= 4 ? reports(a1.admission_id) : null;
  }, { timeoutMs: 6 * P, intervalMs: 2000 });
  const [a] = (await admissions(ctx.clusterId)).filter((x) => x.admission_id === a1.admission_id);
  const iso = await ctx.api.ok("GET", `/api/v2/clusters/${ctx.clusterId}/isolation`, { session: ctx.admin });
  const viewed = iso.pods.find((p) => p.admissionId === a1.admission_id);
  const [probeKey] = await sql(`select probe_public_key from isolation_admissions where admission_id = '${a1.admission_id}'`);
  const problems = chainProblems(rows, probeKey.probe_public_key);
  const control = chainProblems(rows, probeKey.probe_public_key, { wrongDigest: true });
  const gaps = rows.slice(1).map((r, i) => r.received - rows[i].received);
  Object.assign(it.measures, {
    reports: rows.length, ackedSeq: a.acked_seq, apiLastSeq: viewed?.lastSeq, apiState: viewed?.state, apiReporting: viewed?.reporting,
    states: [...new Set(rows.map((r) => r.state))], receivedGapsMs: gaps, receivedMonotonic: gaps.every((g) => g >= 0),
  });
  expect(it, problems.length === 0, `chain: ${problems.join("; ")}`);
  expect(it, a.acked_seq === rows.length && rows.at(-1).seq === rows.length, `acked ${a.acked_seq} of ${rows.length} contiguous reports`);
  expect(it, viewed && viewed.lastSeq >= a.acked_seq - 1 && viewed.reporting === "reporting", `getClusterIsolation: ${JSON.stringify(viewed)}`);
  expect(it, gaps.every((g) => g >= 0), "reports received out of seq order");
  negative(it, "the chain check with a wrong digest (whole JWS hashed) must fail", "problems", `${control.length} problems`, control.length > 0);
  done(it);
}

/** Item 4: a second pod: its admission is held until the first pod's chain answers the current challenge. */
async function secondPod() {
  const it = item("4", "Second pod (scale 2): admission held until pod 1 answers the current challenge, then granted", {
    hold: "granted only after pod 1's acked report carries the request's challenge", latency: `request → grant ≤ P + T + 2 × agent interval ≈ ${(P + T + 2 * AGENT_INTERVAL) / 1000} s (< ${DECISION / 1000} s)` });
  const known = new Set((await live()).map((p) => p.uid));
  await helm(["upgrade", "dp", CHART, "-n", NS.dp, "-f", await ctx.helmValues([ctx.k1], 2)]);
  mark("helm upgrade", { replicas: 2 });
  const pod = await newPod(known);
  ctx.p2 = pod;
  const sampler = new NginxSampler(pod.name);
  sampler.start();
  try {
    const granted = await waitFor("pod 2 admission granted", () => grantedOf(ctx.clusterId, pod.uid), { timeoutMs: 180_000 });
    const rows = await reports(ctx.a1.admission_id);
    const answer = rows.find((r) => r.challenge === granted.challenge);
    const all = await admissionOf(ctx.clusterId, pod.uid);
    await waitFor("nginx in pod 2", async () => sampler.samples.some((s) => s.nginx > 0), { timeoutMs: P + T + S + 30_000, intervalMs: 300 });
    await sampler.stop();
    const nginxBefore = sampler.samples.filter((s) => s.start < granted.decided && s.nginx > 0).length;
    Object.assign(it.measures, {
      requests: all.map((a) => ({ outcome: a.outcome, reason: a.reason, waitedMs: (a.decided ?? Date.now()) - a.requested })),
      requestToGrantMs: granted.decided - granted.requested,
      requestToAnswerReceivedMs: answer ? answer.received - granted.requested : null,
      answerToGrantMs: answer ? granted.decided - answer.received : null,
      answerSeq: answer?.seq, samplesBeforeGrant: sampler.samples.filter((s) => s.end < granted.decided).length, nginxBeforeGrant: nginxBefore,
    });
    expect(it, answer, "no report of pod 1 carries the granted request's challenge");
    expect(it, answer && answer.received <= granted.decided, "granted before pod 1's answer was received");
    expect(it, granted.decided - granted.requested <= DECISION, "grant later than the decision window");
    expect(it, nginxBefore === 0, `nginx in pod 2 before its grant (${nginxBefore} samples)`);
    // Held: the request was not decided before the answer, and no earlier report of pod 1 carried that challenge.
    negative(it, "pod 2's request granted before pod 1 answered its challenge", "never", answer ? `answer received ${answer.received - granted.requested} ms after the request, grant ${granted.decided - answer.received} ms after it` : "no answer", Boolean(answer) && answer.received > granted.requested);
    ctx.a2 = granted;
  } finally {
    if (sampler.running) await sampler.stop();
  }
  done(it);
}

/** Item 6: graceful deletion: the final pod-terminated report with kongStopConfirmed closes the admission. */
async function gracefulDeletion() {
  const it = item("6", "Graceful deletion: final pod-terminated report with kongStopConfirmed closes the admission (native sidecar order measured)", {
    order: "kong exits before the probe's final report; the agent sends it after", kongStop: "Kong stopped ≤ 20 s after the deletion is observed; pod gone ≤ 30 s (grace)" });
  const pod = ctx.p1;
  const known = new Set((await live()).map((p) => p.uid));
  const follow = Object.fromEntries(["kong", "isolation-probe", "agent"].map((c) => [c, new Follower(pod.name, c)]));
  followers.push(...Object.values(follow));
  await sleep(2000);
  let lastStatus = null;
  const t0 = Date.now();
  await kubectl(["-n", NS.dp, "delete", "pod", pod.name, "--wait=false"]);
  mark("graceful delete", { pod: pod.name });
  for (;;) {
    const r = await kubectl(["-n", NS.dp, "get", "pod", pod.name, "-o", "json"], { allowFail: true });
    if (r.code !== 0) break;
    const p = JSON.parse(r.stdout);
    if (p.metadata.uid !== pod.uid) break;
    lastStatus = Object.fromEntries([...(p.status.initContainerStatuses ?? []), ...(p.status.containerStatuses ?? [])].map((s) => [s.name, s.state]));
    if (Date.now() - t0 > 60_000) break;
    await sleep(250);
  }
  const gone = Date.now();
  await Promise.race([Promise.all(Object.values(follow).map((f) => f.closed)), sleep(5000)]);
  const closed = await waitFor("pod 1 admission closed", async () => (await admissions(ctx.clusterId)).find((a) => a.admission_id === ctx.a1.admission_id && a.state !== "open"), { timeoutMs: 30_000 }).catch(() => null);
  const rows = await reports(ctx.a1.admission_id);
  const final = rows.at(-1);
  const kongLast = follow.kong.lines.at(-1);
  const kongStopLine = firstLine(follow.kong.lines.filter((l) => l.at >= t0), /exited|stop signal/);
  const probeFinal = firstLine(follow["isolation-probe"].lines, /final report of admission/);
  const finished = (name) => Date.parse(lastStatus?.[name]?.terminated?.finishedAt ?? "") || null;
  Object.assign(it.measures, {
    deleteToPodGoneMs: gone - t0,
    deleteToKongStopLogMs: kongStopLine ? kongStopLine.at - t0 : null,
    kongLastLog: kongLast?.text, deleteToKongLastLogMs: kongLast ? kongLast.at - t0 : null,
    deleteToProbeFinalLogMs: probeFinal ? probeFinal.at - t0 : null, probeFinalLog: probeFinal?.text,
    finalReport: final ? { seq: final.seq, final: final.final, finalReason: final.final_reason, kongStopConfirmed: final.kong_stop_confirmed, deleteToReceivedMs: final.received - t0 } : null,
    containerFinishedAt: { kong: finished("kong"), "isolation-probe": finished("isolation-probe"), agent: finished("agent") },
    admission: closed ? { state: closed.state, closeReason: closed.close_reason, deleteToClosedMs: closed.closed - t0 } : null,
  });
  expect(it, final?.final && final.final_reason === "pod-terminated" && final.kong_stop_confirmed === true, `last report ${JSON.stringify(it.measures.finalReport)}`);
  expect(it, closed?.state === "closed" && closed.close_reason === "kong-stop-confirmed", `admission ${JSON.stringify(it.measures.admission)}`);
  expect(it, kongLast && probeFinal && kongLast.at <= probeFinal.at, "the probe's final report precedes Kong's last line");
  expect(it, probeFinal && final && probeFinal.at <= final.received, "the CP received the final report before the probe queued it");
  const f = it.measures.containerFinishedAt;
  if (f.kong && f["isolation-probe"] && f.agent) expect(it, f.kong <= f["isolation-probe"] && f["isolation-probe"] <= f.agent, `container finishedAt order ${JSON.stringify(f)} (second precision)`);
  else it.notes.push(`container finishedAt not all observed before the pod disappeared: ${JSON.stringify(f)}`);
  expect(it, gone - t0 <= 30_000 + 5_000, `pod took ${gone - t0} ms to disappear`);
  ctx.p3 = await newPod(known);
  ctx.a3 = await waitFor("replacement pod admission granted", () => grantedOf(ctx.clusterId, ctx.p3.uid), { timeoutMs: 120_000 });
  it.measures.replacementRequestToGrantMs = ctx.a3.decided - ctx.a3.requested;
  done(it);
}

/** Item 9: the agent of a pod stopped: its reports stop reaching the CP, new admissions are held; back when it resumes. */
async function agentStopped() {
  const it = item("9", "Agent stopped (SIGSTOP): report gap → new admissions held; resumes when the agent does", {
    hold: "no grant while the silent chain cannot answer", communication: `communication-failure ${COMMUNICATION / 1000} s after the last report (alert, not releasable: 409)`, resume: `resume → grant ≤ P + T + 2 × agent interval ≈ ${(P + T + 2 * AGENT_INTERVAL) / 1000} s` });
  const silent = ctx.p2;
  const { node, pid } = await containerPid(silent.name, "agent", "gromesh-agent");
  const known = new Set((await live()).map((p) => p.uid));
  await docker(["exec", node, "kill", "-STOP", String(pid)]);
  const stopped = Date.now();
  mark("agent SIGSTOP", { pod: silent.name, pid });
  await kubectl(["-n", NS.dp, "delete", "pod", ctx.p3.name, "--wait=false"]);
  const pod = await newPod(known);
  ctx.p4 = pod;
  // Held past the decision window and past the communication-failure threshold.
  const pendency = await waitFor("communication-failure for the silent admission", async () => (await pendencies(ctx.clusterId)).find((p) => p.admission_id === ctx.a2.admission_id && p.lifecycle === "communication-failure"), { timeoutMs: COMMUNICATION + 60_000, intervalMs: 2000 });
  await waitFor("a refused request of the new pod", async () => (await admissionOf(ctx.clusterId, pod.uid)).some((a) => a.outcome === "refused"), { timeoutMs: DECISION + 30_000, intervalMs: 2000 });
  const whileStopped = await admissionOf(ctx.clusterId, pod.uid);
  const [silentRow] = (await admissions(ctx.clusterId)).filter((a) => a.admission_id === ctx.a2.admission_id);
  const release = await ctx.api.req("POST", `/api/v2/clusters/${ctx.clusterId}/isolation-releases`, { session: ctx.admin, body: { pendencyId: pendency.id, justification: "lab: communication-failure must not be releasable" } });
  negative(it, "release a communication-failure pendency (admin session+CSRF)", 409, release.status, release.status === 409);
  negative(it, "new pod granted while the agent is stopped", "no grant", whileStopped.map((a) => `${a.outcome}${a.reason ? `/${a.reason}` : ""}`).join(","), !whileStopped.some((a) => a.outcome === "granted"));
  await docker(["exec", node, "kill", "-CONT", String(pid)]);
  const resumed = Date.now();
  mark("agent SIGCONT", { stoppedMs: resumed - stopped });
  const granted = await waitFor("new pod granted after the agent resumed", () => grantedOf(ctx.clusterId, pod.uid), { timeoutMs: DECISION + 60_000 + P, intervalMs: 1000 });
  const after = await pendencies(ctx.clusterId);
  const closedPendency = after.find((p) => p.id === pendency.id);
  const rows = await reports(ctx.a2.admission_id);
  const backlog = rows.filter((r) => r.received >= resumed);
  Object.assign(it.measures, {
    stoppedMs: resumed - stopped,
    lastReportBeforeStopToPendencyMs: pendency.opened - (silentRow.last_report ?? stopped),
    newPodRequestsWhileStopped: whileStopped.map((a) => ({ outcome: a.outcome, reason: a.reason })),
    resumeToBacklogMs: backlog.length ? backlog[0].received - resumed : null, backlogReports: backlog.length,
    resumeToGrantMs: granted.decided - resumed,
    pendencyAfterResume: closedPendency ? { lifecycle: closedPendency.lifecycle, closeReason: closedPendency.close_reason, resumeToClosedMs: closedPendency.closed ? closedPendency.closed - resumed : null } : null,
  });
  expect(it, pendency.opened - (silentRow.last_report ?? stopped) >= COMMUNICATION - 2_000, "communication-failure opened before 60 s of silence");
  expect(it, closedPendency?.lifecycle === "closed" && closedPendency.close_reason === "chain-resumed", `pendency after resume ${JSON.stringify(closedPendency)}`);
  expect(it, chainProblems(rows, (await sql(`select probe_public_key from isolation_admissions where admission_id = '${ctx.a2.admission_id}'`))[0].probe_public_key).length === 0, "the chain across the stop is broken");
  expect(it, granted.decided - resumed <= P + T + 2 * AGENT_INTERVAL + 30_000, `resume → grant ${granted.decided - resumed} ms (includes the agent's refused backoff ≤ 30 s)`);
  ctx.a4 = granted;
  done(it);
}

/** Items 5 and 7: a pod killed before its final report; held, communication-failure, unconfirmed-isolation; CP restart keeps it; release. */
async function killedPod() {
  const it5 = item("5", "Pod deleted with its final report lost (agent frozen, then --grace-period=0 --force): admissions held, communication-failure, unconfirmed-isolation after 10 min, release by platform admin only", {
    communication: `${COMMUNICATION / 1000} s after the last report`, unconfirmed: `${UNCONFIRMED / 60_000} min after the last report`, release: "session + CSRF + justification, platform admin only" });
  const victim = ctx.p2;
  const known = new Set((await live()).map((p) => p.uid));
  // A force deletion alone still lets the native sidecars stop in order and deliver the final report (seen in this
  // lab: the admission closed with kongStopConfirmed 1 s later). A pod whose final report is lost is one whose agent
  // cannot carry it: freeze the agent first, then delete with no grace.
  const frozen = await containerPid(victim.name, "agent", "gromesh-agent");
  await docker(["exec", frozen.node, "kill", "-STOP", String(frozen.pid)]);
  const t0 = Date.now();
  await kubectl(["-n", NS.dp, "delete", "pod", victim.name, "--grace-period=0", "--force"], { allowFail: true });
  mark("agent frozen, then force delete", { pod: victim.name, agentPid: frozen.pid });
  const pod = await newPod(known);
  ctx.p5 = pod;
  await sleep(10_000);
  const rows = await reports(ctx.a2.admission_id);
  const finalArrived = rows.some((r) => r.final);
  it5.measures.finalReportReachedCp = finalArrived;
  expect(it5, !finalArrived, "a final report reached the control plane: the force deletion was not a SIGKILL before it");
  const [a2] = (await admissions(ctx.clusterId)).filter((a) => a.admission_id === ctx.a2.admission_id);
  const lastReport = a2.last_report;
  const communication = await waitFor("communication-failure", async () => (await pendencies(ctx.clusterId)).find((p) => p.admission_id === ctx.a2.admission_id && p.lifecycle === "communication-failure"), { timeoutMs: COMMUNICATION + 60_000, intervalMs: 2000 });
  it5.measures.lastReportToCommunicationFailureMs = communication.opened - lastReport;
  it5.measures.killToLastReportMs = lastReport - t0;
  expect(it5, communication.opened - lastReport >= COMMUNICATION - 2_000 && communication.opened - lastReport <= COMMUNICATION + 15_000, `communication-failure ${communication.opened - lastReport} ms after the last report`);
  // While waiting for the 10 min: the new pod is held (refused by timeout, never granted).
  log(`waiting for unconfirmed-isolation (${Math.round((lastReport + UNCONFIRMED - Date.now()) / 1000)} s)`);
  const unconfirmed = await waitFor("unconfirmed-isolation", async () => {
    // getClusterIsolation runs the timers as the next decision would.
    const iso = await ctx.api.ok("GET", `/api/v2/clusters/${ctx.clusterId}/isolation`, { session: ctx.admin });
    return iso.pendencies.find((p) => p.id === communication.id && p.kind === "unconfirmed-isolation") ? (await pendencies(ctx.clusterId)).find((p) => p.id === communication.id) : null;
  }, { timeoutMs: UNCONFIRMED + 120_000, intervalMs: 5000 });
  const at = Date.now();
  const heldRequests = await admissionOf(ctx.clusterId, pod.uid);
  const [audit] = await sql(`select ${ms("at")} as at from audit_events where action = 'isolation.pendency.supersede' and entity_id = '${communication.id}' order by at limit 1`).catch(() => [null]);
  const supersededAt = audit ? local(audit.at) : at;
  it5.measures.lastReportToUnconfirmedMs = supersededAt - lastReport;
  it5.measures.requestsDuringWait = heldRequests.map((a) => `${a.outcome}${a.reason ? `/${a.reason}` : ""}`);
  expect(it5, supersededAt - lastReport >= UNCONFIRMED - 2_000 && supersededAt - lastReport <= UNCONFIRMED + 20_000, `unconfirmed-isolation ${supersededAt - lastReport} ms after the last report`);
  negative(it5, "the new pod granted while the killed pod's admission is open", "no grant", it5.measures.requestsDuringWait.join(","), !heldRequests.some((a) => a.outcome === "granted"));
  await waitFor("a request refused with pendency-open", async () => (await admissionOf(ctx.clusterId, pod.uid)).some((a) => a.reason === "pendency-open" && a.requested >= at - 5_000), { timeoutMs: 90_000, intervalMs: 2000 });

  const it7 = item("7", "Control plane restart with the pendency open: it keeps blocking", { block: "requests after the restart refused pendency-open" });
  const restart = Date.now();
  await kubectl(["-n", NS.cp, "delete", "pod", "-l", "app=control-plane", "--wait=true"], { timeout: 120_000 });
  await kubectl(["-n", NS.cp, "rollout", "status", "deployment/control-plane", "--timeout=180s"], { timeout: 200_000 });
  await ctx.forward.start();
  await waitFor("control plane back", async () => (await ctx.api.req("GET", "/healthz")).status === 200, { timeoutMs: 120_000 });
  const back = Date.now();
  mark("control plane restarted", { downMs: back - restart });
  const iso = await ctx.api.ok("GET", `/api/v2/clusters/${ctx.clusterId}/isolation`, { session: ctx.admin });
  const stillOpen = iso.pendencies.find((p) => p.id === communication.id);
  const refusedAfter = await waitFor("a request refused with pendency-open after the restart", async () => (await admissionOf(ctx.clusterId, pod.uid)).find((a) => a.reason === "pendency-open" && a.requested >= back), { timeoutMs: 90_000, intervalMs: 2000 });
  Object.assign(it7.measures, { restartMs: back - restart, pendencyAfterRestart: stillOpen?.kind, releasable: stillOpen?.releasable, refusedAfterRestartMs: refusedAfter.requested - back });
  expect(it7, stillOpen?.kind === "unconfirmed-isolation" && stillOpen.releasable === true, `pendency after the restart ${JSON.stringify(stillOpen)}`);
  negative(it7, "a request after the restart granted", "refused pendency-open", `${refusedAfter.outcome}/${refusedAfter.reason}`, refusedAfter.outcome === "refused" && refusedAfter.reason === "pendency-open");
  done(it7);

  // The release: platform admin, session + CSRF + justification; everything else refused.
  const path = `/api/v2/clusters/${ctx.clusterId}/isolation-releases`;
  const body = { pendencyId: communication.id, justification: "lab N2-E2: pod force-deleted, its isolation is unconfirmed" };
  for (const [what, options, expected] of [
    ["release by an editor (session+CSRF)", { session: ctx.editor, body }, 403],
    ["release by the editor's API token", { token: ctx.editorToken, body }, [401, 403]],
    ["release by the platform admin's API token", { token: ctx.adminToken, body }, [401, 403]],
    ["release by the platform admin's session without CSRF", { session: ctx.admin, csrf: false, body }, 403],
    ["release by the platform admin without a justification", { session: ctx.admin, body: { pendencyId: communication.id, justification: "" } }, 422],
  ]) {
    const res = await ctx.api.req("POST", path, options);
    negative(it5, what, [expected].flat().join(" or "), res.status, [expected].flat().includes(res.status));
  }
  const notReleased = (await pendencies(ctx.clusterId)).find((p) => p.id === communication.id);
  expect(it5, notReleased.lifecycle === "unconfirmed-isolation", `the refused attempts changed the pendency: ${notReleased.lifecycle}`);
  const released = await ctx.api.req("POST", path, { session: ctx.admin, body });
  const releasedAt = Date.now();
  expect(it5, released.status === 201, `release by the platform admin answered ${released.status} ${JSON.stringify(released.body)}`);
  mark("released", { pendency: communication.id });
  const granted = await waitFor("the held pod granted after the release", () => grantedOf(ctx.clusterId, pod.uid), { timeoutMs: DECISION + 60_000 + P, intervalMs: 1000 });
  const [orphan] = (await admissions(ctx.clusterId)).filter((a) => a.admission_id === ctx.a2.admission_id);
  const [p] = (await pendencies(ctx.clusterId)).filter((x) => x.id === communication.id);
  const [rel] = await sql(`select kind, kid, ${ms("expires_at")} - ${ms("created_at")} as ttl from isolation_releases where pendency_id = '${communication.id}'`);
  Object.assign(it5.measures, { releaseToGrantMs: granted.decided - releasedAt, orphan: { state: orphan.state, closeReason: orphan.close_reason }, pendency: { lifecycle: p.lifecycle, justification: Boolean(p.justification), releasedBy: p.released_by?.type }, release: rel });
  expect(it5, orphan.state === "closed-without-proof", `orphan admission ${orphan.state}`);
  expect(it5, p.lifecycle === "released", `pendency ${p.lifecycle}`);
  // created_at is the transaction's start and expiresAt is taken with clock_timestamp() when signing (a few ms later):
  // 15 min from the signature, within a second of the row.
  expect(it5, rel?.kind === "unconfirmed-isolation" && rel.kid === ctx.k1.kid && Math.abs(Number(rel.ttl) - 15 * 60_000) <= 1_000, `release row ${JSON.stringify(rel)}`);
  ctx.a5 = granted;
  done(it5);
}

/** Item 8: revoking the instance key: new admissions refused no-signing-key; a chart rollout without it makes the probe drop its admission. */
async function revocation() {
  const it = item("8", "Instance key revoked: new admissions → no-signing-key; chart rollout without the key → the probe drops the admission", {
    refuse: "refused no-signing-key", drop: "at the probe's next round after the kubelet refreshes the ConfigMap (≤ kubelet sync + P)" });
  const known = new Set((await live()).map((p) => p.uid));
  const revoke = await ctx.api.req("POST", `/api/v2/instance/signing-keys/${ctx.k1.kid}/revoke`, { token: ctx.adminToken, body: { justification: "lab N2-E2: revocation by token must fail" } });
  negative(it, "revoke the key with the admin's API token", "401 or 403", revoke.status, [401, 403].includes(revoke.status));
  const revoked = await ctx.api.ok("POST", `/api/v2/instance/signing-keys/${ctx.k1.kid}/revoke`, { session: ctx.admin, body: { justification: "lab N2-E2: instance key compromised (drill)" } });
  const revokedAt = Date.now();
  mark("key revoked", { kid: ctx.k1.kid, openAdmissions: revoked.openAdmissions });
  it.measures.openAdmissionsAtRevocation = revoked.openAdmissions;
  // Any serving-or-not admitted pod of the data plane: its replacement asks for an admission after the revocation.
  const pods = await live();
  const victim = pods.find((p) => p.uid === (ctx.p4 ?? ctx.p5)?.uid) ?? pods[0];
  await kubectl(["-n", NS.dp, "delete", "pod", victim.name, "--wait=false"]);
  const pod = await newPod(known);
  const refused = await waitFor("a request refused no-signing-key", async () => (await admissionOf(ctx.clusterId, pod.uid)).find((a) => a.reason === "no-signing-key"), { timeoutMs: 90_000, intervalMs: 1000 });
  it.measures.revokeToRefusedMs = refused.decided - revokedAt;
  negative(it, "a new admission after the revocation", "refused no-signing-key", `${refused.outcome}/${refused.reason}`, refused.outcome === "refused");
  expect(it, !(await admissionOf(ctx.clusterId, pod.uid)).some((a) => a.outcome === "granted"), "an admission was granted after the revocation");

  // The rollout without the key: a new key K2 (the set needs 1 to 3 keys); the existing pod's admission is K1's.
  const k2 = await ctx.api.ok("POST", "/api/v2/instance/signing-keys", { session: ctx.admin, body: { validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString() } });
  ctx.k2 = { kid: k2.kid, publicKey: k2.publicKey };
  // A pod still admitted with the revoked key (the replacement of item 5's pod, or any other admitted one).
  const holder = (await live()).find((p) => p.uid === ctx.p5?.uid) ?? (await live()).find((p) => p.uid !== pod.uid);
  ctx.p5 = holder;
  ctx.a5 ??= await grantedOf(ctx.clusterId, holder.uid);
  const follower = new Follower(holder.name, "isolation-probe");
  followers.push(follower);
  await sleep(1000);
  const rollout = Date.now();
  await helm(["upgrade", "dp", CHART, "-n", NS.dp, "-f", await ctx.helmValues([ctx.k2], 2)]);
  mark("chart rollout without the revoked key", { trustSet: [ctx.k2.kid] });
  const configMapName = (await json(["-n", NS.dp, "get", "configmap", "-l", "app.kubernetes.io/instance=dp"])).items.map((c) => c.metadata.name).find((n) => n.endsWith("isolation-probe"));
  const dropped = await waitFor("the probe drops the admission of the revoked key", async () => follower.lines.find((l) => l.at >= rollout && /no longer valid|not in the instance trust set/.test(l.text)), { timeoutMs: 150_000, intervalMs: 1000 }).catch(() => null);
  const seen = await kubectl(["-n", NS.dp, "exec", holder.name, "-c", "isolation-probe", "--", "/gromesh/isolation-bin/isolation-probe", "check-trust-set", "/etc/gromesh/instance-keys.json"], { allowFail: true });
  const leaseGone = await kubectl(["-n", NS.dp, "exec", holder.name, "-c", "kong", "--", "sh", "-c", "test -e /gromesh/isolation/lease.json && echo present || echo absent"], { allowFail: true });
  const reportsAfter = (await reports(ctx.a5.admission_id)).filter((r) => dropped && r.received > dropped.at + 2_000);
  Object.assign(it.measures, {
    configMap: configMapName, rolloutToDropMs: dropped ? dropped.at - rollout : null, dropLog: dropped?.text,
    trustSetInPod: seen.stdout.trim() || seen.stderr.trim(), leaseAfterDrop: leaseGone.stdout.trim(), reportsAfterDrop: reportsAfter.length,
  });
  expect(it, dropped, "the probe did not drop the admission after the rollout");
  expect(it, leaseGone.stdout.trim() === "absent", `lease after the drop: ${leaseGone.stdout.trim()}`);
  expect(it, reportsAfter.length === 0, `${reportsAfter.length} reports of the dropped admission after the drop`);
  // What follows the drop, observed for 2 min: the agent of the pod keeps its granted admission and never asks again.
  await sleep(120_000);
  const holderRequests = await admissionOf(ctx.clusterId, ctx.p5.uid);
  const newRequests = await admissionOf(ctx.clusterId, pod.uid);
  const iso = await ctx.api.ok("GET", `/api/v2/clusters/${ctx.clusterId}/isolation`, { session: ctx.admin });
  Object.assign(it.measures, {
    afterDrop: {
      holderRequests: holderRequests.map((a) => `${a.outcome}${a.reason ? `/${a.reason}` : ""}${a.kid ? `@${a.kid.slice(0, 8)}` : ""}`),
      newPodRequests: newRequests.map((a) => `${a.outcome}${a.reason ? `/${a.reason}` : ""}${a.kid ? `@${a.kid.slice(0, 8)}` : ""}`),
      pendencies: iso.pendencies.map((p) => p.kind),
      pods: iso.pods.filter((p) => p.admission !== "closed").map((p) => ({ pod: p.podName, admission: p.admission, reporting: p.reporting, state: p.state })),
    },
  });
  done(it);
}

const ITEM_OF = { reportsInOrder: "3", secondPod: "4", gracefulDeletion: "6", agentStopped: "9", killedPod: "5, 7", revocation: "8" };

async function main() {
  const steps = [setup, coldStart, reportsInOrder, secondPod, gracefulDeletion, agentStopped, killedPod, revocation];
  // LAB_SKIP=<step,...> leaves a step out (recorded as skipped), e.g. one whose finding is awaiting a decision.
  const skip = new Set((process.env.LAB_SKIP ?? "").split(",").filter(Boolean));
  try {
    for (const step of steps) {
      if (skip.has(step.name)) {
        report.items.push({ id: ITEM_OF[step.name] ?? step.name, title: step.name, result: "skipped", failures: [], notes: ["LAB_SKIP"] });
        log(`step ${step.name}: SKIPPED (LAB_SKIP)`);
        continue;
      }
      if (ctx.blocked) {
        report.items.push({ id: ITEM_OF[step.name] ?? step.name, title: step.name, result: "blocked", failures: [], notes: [ctx.blocked] });
        log(`step ${step.name}: BLOCKED (${ctx.blocked})`);
        continue;
      }
      try {
        await step();
      } catch (error) {
        const it = report.items.at(-1);
        log(`step ${step.name} aborted: ${error.stack ?? error}`);
        if (it && it.result === "pending") { it.failures.push(`aborted: ${error.message}`); it.result = "fail"; }
        report.aborted = { step: step.name, error: String(error.message ?? error) };
        save();
        break;
      }
    }
  } finally {
    for (const f of followers) f.stop();
    ctx.forward?.stop();
    report.finishedAt = new Date().toISOString();
    report.dependsOnN3 = ["n: traffic served behind the guard (route guard canary)", "o: 503 / Kong stop budgets on a serving pod", "p (part): readiness Ready with the canary"];
    save();
    console.log(`results: ${join(out, "results.json")}`);
  }
  const failed = report.items.filter((i) => i.result !== "pass");
  if (failed.length || report.aborted) process.exit(1);
}

await main();
