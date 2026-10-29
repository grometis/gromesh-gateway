#!/usr/bin/env node
// N2 admission suite with the real components (W0 items q, and what does not depend on a serving pod) on the N2 lab:
// the control plane built from main (with its own Postgres), the data plane chart in Workspaces mode with the real
// agent and isolation-probe, the probe's targets being the N2-E1 fixtures behind the protected policies. The agents
// reach the control plane through relay.mjs, transparent except while item 3 withholds one report.
//   LAB_KUBECONFIG=<file> [LAB_CLUSTER_SH=<e2e/kind/n2/cluster.sh>] [LAB_OUT=<dir>] [LAB_KEEP=1] node e2e/kind/n2/components/run.mjs
// Images (loaded beforehand into the nodes that run them): CP_IMAGE, AGENT_IMAGE, KONG_IMAGE (repo:tag), PG_IMAGE.
// Known limit: until N3 the agent applies the v1 snapshot, so the guard canary never answers and every pod ends in
// guard-missing (Kong stopped, fail-closed). What needs a serving pod is reported as blocked, never as passed.
import { createHash, createPublicKey, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import {
  Api, apply, assertLab, CONTEXT, controlPlaneObjects, controlPlaneSecret, cpSecrets, createSecret, dbSkew, denyPolicies, docker, Forward, helm, here, json,
  kubeconfig, kubectl, NODES, NS, registrationSecret, relayObjects, removeSuiteObjects, root, run, sql,
  scrubKong,
} from "./lab.mjs";

const out = process.env.LAB_OUT ?? mkdtempSync(join(tmpdir(), "gromesh-n2-comp-"));
const IMAGES = {
  cp: process.env.CP_IMAGE ?? "gromesh-n2c-cp:41db8aa",
  agent: process.env.AGENT_IMAGE ?? "gromesh-n2c-agent:13e340c",
  // The lab's Kong (ghcr.io/grometis/gromesh-kong@sha256:786d736c…) re-tagged locally: the tag carries no version.
  kong: process.env.KONG_IMAGE ?? "gromesh-n2c-kong:786d736c",
  pg: process.env.PG_IMAGE ?? "postgres:16-alpine",
};
const FIXTURE_IMAGE = /^FIXTURE_IMAGE=(.+)$/m.exec(readFileSync(join(here, "../versions.env"), "utf8"))[1];
const KONG_VERSION = "3.9.4";
const CHART = join(root, "deploy/helm/data-plane");
const SELECTOR = "app.kubernetes.io/name=data-plane,app.kubernetes.io/instance=dp";
const RELAY_URL = `http://cp-relay.${NS.cp}.svc.cluster.local:3000`;
// agent-protocol-v2 and the control plane's timers.
const P = 15_000, T = 3_000, S = 1_000, AGENT_INTERVAL = 2_000, DECISION = 45_000, COMMUNICATION = 60_000, UNCONFIRMED = 600_000;
// What each item asserts, exactly as its published budget says.
const BUDGET = {
  grantToNginx: P + T + S + 2_000, // + the agent's handoff of the admission to the probe
  cadenceTolerance: 2 * AGENT_INTERVAL + 1_000, // the agent forwards the outbox every interval
  heldGrant: P + T + 3 * AGENT_INTERVAL + 2_000, // challenge fetch, report forward, decision poll
  kongExit: 20_000,
  podGone: 35_000, // grace 30 s + the API's own latency
  resumeGrant: P + T + 3 * AGENT_INTERVAL + 2_000 + 30_000, // + the agent's backoff after a refused request
  communication: [COMMUNICATION - 2_000, COMMUNICATION + 15_000],
  unconfirmed: [UNCONFIRMED - 2_000, UNCONFIRMED + 20_000],
  drop: 60_000 + 60_000 + P, // kubelet sync + ConfigMap cache + the probe's next round
  afterDrop: 120_000,
  inFlight: 2 * AGENT_INTERVAL + 1_000, // a report already in the outbox when the probe dropped the admission
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const s = (ms) => `${ms / 1000} s`;

const report = { startedAt: new Date().toISOString(), images: IMAGES, revisions: { cp: process.env.CP_REV, agent: process.env.AGENT_REV }, context: CONTEXT, budgets: BUDGET, items: [], blocked: [], findings: [], timeline: [] };
const save = () => writeFileSync(join(out, "results.json"), scrubKong(JSON.stringify(report, null, 2)));
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
/** Only at an item's normal end: an exception leaves it pending, and main records it as failed. */
function done(it) {
  it.result = it.failures.length ? "fail" : "pass";
  save();
  log(`item ${it.id}: ${it.result.toUpperCase()} ${JSON.stringify(it.measures)}`);
  for (const f of it.failures) log(`  ${f}`);
}
/** Something the suite cannot exercise yet: never a pass. */
function blocked(entry) {
  report.blocked.push(entry);
  log(`BLOCKED ${entry.id}: ${entry.missing}`);
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
  // The chart has no collector on the pod's loopback yet: this target is refused, so the probe proves CAP-7 vacuously
  // (item 2 shows it and reports CAP-7 as blocked). The probe's configuration needs a target per capability.
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
    containers: Object.fromEntries([...(p.status.initContainerStatuses ?? []), ...(p.status.containerStatuses ?? [])].map((x) => [x.name, x])),
  }));
}
const live = async () => (await pods()).filter((p) => !p.deleting);
const newPod = (known) => waitFor("a new data plane pod", async () => (await live()).find((p) => !known.has(p.uid)), { timeoutMs: 90_000 });

const NGINX_SAMPLE = `printf '%s ' "$(cat /proc/[0-9]*/comm 2>/dev/null | grep -c '^nginx$')"; cat /gromesh/kong-state/kong-state.json 2>/dev/null || true`;

/** Kong container samples: nginx processes and kong-supervisor's state, each with the interval it was taken in. */
class NginxSampler {
  constructor(pod) { this.pod = pod; this.samples = []; this.running = false; }
  start() {
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        const start = Date.now();
        const r = await kubectl(["-n", NS.dp, "exec", this.pod, "-c", "kong", "--", "sh", "-c", NGINX_SAMPLE], { allowFail: true, timeout: 10_000 });
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

// Every instant the lab's nodes stamp (container logs, crictl, Postgres) is on the Docker VM's clock: mapped back to
// this host's clock by the skew measured against Postgres, like the database's own instants.
let skew = 0;
const local = (dbMs) => (dbMs == null ? null : Number(dbMs) - skew);
const nodeTime = (rfc3339) => local(Date.parse(rfc3339.replace(/(\.\d{3})\d*Z$/, "$1Z")));
function parseLine(line) {
  const space = line.indexOf(" ");
  return { at: nodeTime(line.slice(0, space)), text: line.slice(space + 1) };
}
async function logs(pod, container) {
  const { stdout } = await kubectl(["-n", NS.dp, "logs", "--timestamps", pod, "-c", container], { allowFail: true });
  return stdout.split("\n").filter(Boolean).map(parseLine);
}
const firstLine = (lines, pattern) => lines.find((l) => pattern.test(l.text));

/** The host pid of a container of a data plane pod, checked against the binary it must be. */
async function containerPid(podName, container, comm) {
  const p = await json(["-n", NS.dp, "get", "pod", podName]);
  const st = [...(p.status.initContainerStatuses ?? []), ...(p.status.containerStatuses ?? [])].find((x) => x.name === container);
  const id = st.containerID.replace(/^containerd:\/\//, "");
  const pid = Number((await docker(["exec", p.spec.nodeName, "crictl", "inspect", "-o", "go-template", "--template", "{{.info.pid}}", id])).stdout.trim());
  const actual = (await docker(["exec", p.spec.nodeName, "cat", `/proc/${pid}/comm`])).stdout.trim();
  if (actual !== comm) throw new Error(`pid ${pid} of ${podName}/${container} is ${actual}, not ${comm}`);
  return { node: p.spec.nodeName, pid, comm };
}

// Every process the suite stops is continued again, whatever happens to the run (thawAll runs on every exit path).
const frozen = new Set();
async function freeze(podName, container, comm) {
  const target = await containerPid(podName, container, comm);
  frozen.add(target);
  await docker(["exec", target.node, "kill", "-STOP", String(target.pid)]);
  return target;
}
async function thaw(target) {
  // A pid that died with its pod may have been reused: only the same binary is continued.
  const comm = await docker(["exec", target.node, "cat", `/proc/${target.pid}/comm`], { allowFail: true });
  // Only the kernel saying the pid does not exist proves the process ended; any other failure keeps it listed.
  if (comm.code !== 0 && /No such file or directory/.test(comm.stderr)) { frozen.delete(target); return "gone"; }
  if (comm.code !== 0) return `unknown: ${comm.stderr.trim()}`;
  if (comm.stdout.trim() !== target.comm) { frozen.delete(target); return `pid reused by ${comm.stdout.trim()}`; }
  const cont = await docker(["exec", target.node, "kill", "-CONT", String(target.pid)], { allowFail: true });
  // A failed SIGCONT keeps the process listed: the run cannot end clean with it still stopped.
  if (cont.code !== 0) return `SIGCONT failed: ${cont.stderr.trim()}`;
  frozen.delete(target);
  return "continued";
}
const thawAll = async () => Promise.all([...frozen].map(thaw));

/** crictl state of a pod's containers, polled on its node until all exited: finishedAt with nanoseconds, the exit codes. */
function watchExits(node, ids, timeoutS) {
  const script = `end=$(( $(date +%s) + ${timeoutS} )); while [ "$(date +%s)" -lt "$end" ]; do all=1; for id in "$@"; do
st=$(crictl inspect -o go-template --template '{{.status.state}} {{.status.finishedAt}} {{.status.exitCode}}' "$id" 2>/dev/null) || st=GONE; echo "$id $st";
case "$st" in CONTAINER_EXITED*) ;; *) all=0 ;; esac; done; [ "$all" = 1 ] && exit 0; sleep 0.05; done; exit 3`;
  return docker(["exec", node, "sh", "-c", script, "sh", ...Object.values(ids)], { allowFail: true, timeout: (timeoutS + 15) * 1000 }).then(({ code, stdout }) => {
    const last = {};
    for (const line of stdout.split("\n").filter(Boolean)) { const [id, ...rest] = line.split(" "); last[id] = rest; }
    const states = Object.fromEntries(Object.entries(ids).map(([name, id]) => {
      const [state, finishedAt, exitCode] = last[id] ?? ["UNSEEN"];
      return [name, { state, exitCode: exitCode == null ? null : Number(exitCode), finishedAt: state === "CONTAINER_EXITED" ? nodeTime(finishedAt) : null, finishedAtNode: finishedAt ?? null }];
    }));
    return { allExited: code === 0, states };
  });
}

// --- relay --------------------------------------------------------------------------------------------------------
async function relayLog() {
  const { stdout } = await kubectl(["-n", NS.cp, "logs", "deploy/cp-relay"]);
  return stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).filter((e) => e.received);
}
const arm = (admissionId, seq) => kubectl(["-n", NS.cp, "exec", "-i", "deploy/cp-relay", "--", "sh", "-c", "cat > /tmp/relay/arm.next && mv /tmp/relay/arm.next /tmp/relay/arm.json"], { input: JSON.stringify({ admissionId, seq }) });
const disarm = () => kubectl(["-n", NS.cp, "exec", "deploy/cp-relay", "--", "rm", "-f", "/tmp/relay/arm.json"]);
const ackOf = (entry, admissionId) => entry?.acks?.find((a) => a.admissionId === admissionId)?.ackedSeq ?? null;

// --- control plane state ------------------------------------------------------------------------------------------
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
const admissionRow = async (admissionId) => (await admissions(ctx.clusterId)).find((a) => a.admission_id === admissionId);
const probeKeyOf = async (admissionId) => (await sql(`select probe_public_key from isolation_admissions where admission_id = '${admissionId}'`))[0].probe_public_key;

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
// instanceId: no v2 deployment in this suite, so any stable id of the run (the instance row arrives with the N3).
const ctx = { instanceId: randomUUID() };
const followers = [];

// The chart's instanceId (agent and probe in Workspaces mode) exists from PR #187 on; a chart without it refuses the key.
const CHART_INSTANCE_ID = "instanceId" in (JSON.parse(readFileSync(join(CHART, "values.schema.json"), "utf8")).properties.workspaces.properties ?? {});
const values = (keys, replicas) => ({
  replicaCount: replicas,
  kong: { image: { repository: IMAGES.kong.split(":")[0], tag: IMAGES.kong.split(":")[1], digest: "", pullPolicy: "Never" } },
  agent: { image: { repository: IMAGES.agent.split(":")[0], tag: IMAGES.agent.split(":")[1], digest: "", pullPolicy: "Never" },
    controlPlaneUrl: RELAY_URL, existingSecret: "dp-registration" },
  networkPolicy: {
    enabled: true,
    controlPlanePeers: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": NS.cp } }, podSelector: { matchLabels: { app: "cp-relay" } } }],
    upstreams: [{ cidr: `${ctx.topo.ext.backend.v4}/32`, ports: [8080] }, { cidr: `${ctx.topo.ext.backend.v6}/128`, ports: [8080] }],
  },
  workspaces: { enabled: true, clusterId: ctx.clusterId, ...(CHART_INSTANCE_ID ? { instanceId: ctx.instanceId } : {}), instanceSigningKeys: keys, probe: { checks: ctx.checks } },
});
// Values through stdin: nothing of the release is written to disk, and they hold no secret anyway.
const release = (verb, keys, replicas) => helm([verb, "dp", CHART, "-n", NS.dp, "-f", "-"], { input: JSON.stringify(values(keys, replicas)) });

/** Before anything is created: every image on the nodes that run it, and the chart renders with this suite's values. */
async function preflight() {
  const where = { cp: [NODES.cp], pg: [NODES.cp], agent: NODES.workers, kong: NODES.workers, fixture: [NODES.cp] };
  const refs = { ...IMAGES, fixture: FIXTURE_IMAGE };
  const ids = {};
  for (const [name, nodes] of Object.entries(where)) {
    for (const node of nodes) {
      const r = await docker(["exec", node, "crictl", "inspecti", "-o", "go-template", "--template", "{{.status.id}}", refs[name]], { allowFail: true });
      if (r.code !== 0) throw new Error(`image ${refs[name]} is not on ${node}: load it first (kind load docker-image)`);
      ids[name] = r.stdout.trim();
    }
  }
  report.imageIds = ids;
  const { publicKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x;
  const kid = createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest("base64url");
  const server = (await json(["version"])).serverVersion.gitVersion;
  const saved = ctx.clusterId;
  ctx.clusterId = randomUUID();
  try {
    await helm(["template", "dp", CHART, "-n", NS.dp, "--kube-version", server.replace(/^v/, ""), "-f", "-"], { input: JSON.stringify(values([{ kid, publicKey: x }], 1)) });
  } finally {
    ctx.clusterId = saved;
  }
}

async function setup() {
  const it = item("1", "Postgres + control plane from main; admin, instance signing key (session+CSRF), cluster, registration token; data plane chart in Workspaces mode", { note: "setup" });
  report.environment = await assertLab();
  const topo = await topology();
  ctx.topo = topo;
  report.topology = topo;
  ctx.checks = probeChecks(topo);
  mark("topology", { nodes: topo.nodes.map((n) => n.name) });
  await preflight();
  mark("preflight", { images: report.imageIds });

  // A fresh, reproducible start: only this suite's namespaces and its own cluster-wide policies are removed. From here
  // on the run owns them, and only then does its cleanup remove them (never after a failed lab check or preflight).
  ctx.owned = true;
  await removeSuiteObjects();

  const secrets = cpSecrets();
  ctx.secrets = secrets;
  await apply([{ apiVersion: "v1", kind: "Namespace", metadata: { name: NS.cp } }]);
  await createSecret(controlPlaneSecret(secrets));
  await apply(controlPlaneObjects({ cpImage: IMAGES.cp, pgImage: IMAGES.pg }));
  await apply(relayObjects({ image: FIXTURE_IMAGE, source: readFileSync(join(here, "relay.mjs"), "utf8") }));
  await kubectl(["-n", NS.cp, "rollout", "status", "deployment/postgres", "--timeout=180s"], { timeout: 200_000 });
  await kubectl(["-n", NS.cp, "rollout", "status", "deployment/control-plane", "--timeout=240s"], { timeout: 260_000 });
  await kubectl(["-n", NS.cp, "rollout", "status", "deployment/cp-relay", "--timeout=120s"], { timeout: 140_000 });
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
  const alive = await liveness(ctx.checks);
  const dead = alive.filter((r) => r.verdict !== "pass");
  it.measures.forbiddenTargetsLive = `${alive.length - dead.length}/${alive.length}`;
  expect(it, dead.length === 0, `forbidden targets not live from the observer: ${dead.map((d) => `${d.id}=${d.outcomes}`).join("; ")}`);

  await apply([{ apiVersion: "v1", kind: "Namespace", metadata: { name: NS.dp } }, ...denyPolicies(topo.net)]);
  await createSecret(registrationSecret(ctx.registrationToken));
  done(it);
}

/** What the kong container's network namespace gets from the CAP-6 and CAP-7 targets on loopback (the kong image has no curl). */
async function loopbackTargets(podName) {
  const lua = `local socket = require "socket"
for _, t in ipairs({ { 9100, "/metrics" }, { 9880, "/" } }) do
  local c = socket.tcp(); c:settimeout(2)
  local ok, err = c:connect("127.0.0.1", t[1])
  if not ok then print(t[1] .. " connect " .. tostring(err)) else
    c:send("GET " .. t[2] .. " HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\n\\r\\n"); print(t[1] .. " " .. tostring(c:receive("*l"))); c:close() end
end`;
  const { stdout } = await kubectl(["-n", NS.dp, "exec", podName, "-c", "kong", "--", "luajit", "-e", lua], { timeout: 30_000 });
  return Object.fromEntries(stdout.trim().split("\n").map((l) => [l.slice(0, l.indexOf(" ")), l.slice(l.indexOf(" ") + 1)]));
}

/** Item 2: cold start, awaiting-admission → admission granted by the real CP, adopted by the real probe; no nginx before it. */
async function coldStart() {
  const it = item("2", "Cold start: the agent registers before Kong may start (Kong version from the pinned image's file), awaiting-admission → admission granted by the CP, verified by the probe; no nginx before the grant", {
    decision: `request → grant ≤ ${s(DECISION)} (no timeout grants)`, start: `grant → nginx ≤ P + T + S + 2 s (agent handoff) = ${s(BUDGET.grantToNginx)}`, nginxBeforeGrant: "0",
    registration: `one registration, no failure, before nginx; kongVersion in the CP = the file seed-config wrote = what Kong reports = ${KONG_VERSION}; no GROMESH_KONG_VERSION; the Kong tag carries no version`,
    cycle: "exactly one admission request before the grant" });
  const t0 = Date.now();
  await release("install", [ctx.k1], 1);
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
        probeLog: probeLogs.map((l) => l.text), samples: sampler.samples.length, nginxInAnySample: sampler.samples.filter((x) => x.nginx > 0).length,
      });
      expect(it, false, `no admission within 180 s: ${nodes} registered nodes, ${requests.length} admission requests`);
      expect(it, sampler.samples.every((x) => x.nginx === 0), "nginx ran without an admission");
      if (nodes === 0) {
        ctx.blocked = { id: "2→all", missing: "the agent never registered in Workspaces mode, so no admission was ever asked", component: "agent (apps/agent)", pr: "#172", unblock: "a registration in this run" };
        report.findings.push({ id: "registration", item: "2", blocking: true, evidence: it.measures });
      }
      done(it);
      return;
    }
    await waitFor("nginx observed in pod 1", async () => sampler.samples.some((x) => x.nginx > 0), { timeoutMs: BUDGET.grantToNginx + 30_000, intervalMs: 300 });
    await sleep(500);
    await sampler.stop();
    const all = await admissionOf(ctx.clusterId, pod.uid);
    const [p] = (await pods()).filter((x) => x.uid === pod.uid);
    const kongLogs = await logs(pod.name, "kong");
    const probeLogs = await logs(pod.name, "isolation-probe");
    const agentLogs = await logs(pod.name, "agent");
    const nginxStart = firstLine(kongLogs, /lease valid: nginx started/);
    const admitted = firstLine(probeLogs, /admitted: /);
    const firstNginx = sampler.samples.find((x) => x.nginx > 0);
    const before = sampler.samples.filter((x) => x.end < granted.decided);
    const startedBefore = sampler.samples.filter((x) => x.start < granted.decided && x.nginx > 0);
    const kongStarted = Date.parse(p.containers.kong?.state?.running?.startedAt ?? p.containers.kong?.lastState?.terminated?.startedAt ?? "");
    const requestsBeforeGrant = all.filter((a) => a.requested <= granted.requested).length;
    Object.assign(it.measures, {
      podCreatedToKongStartedMs: kongStarted - pod.created,
      requestToGrantMs: granted.decided - granted.requested,
      requestsBeforeGrant,
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
    // The kong container may start less than a sampling interval before the grant: then the supervisor's and the
    // probe's own log order below is the evidence, and the samples only add to it. Without either, nothing was measured.
    expect(it, before.length >= 3 || (nginxStart && admitted), `only ${before.length} samples of the kong container before the grant and no supervisor/probe log order: nothing measured`);
    expect(it, startedBefore.length === 0, `nginx seen before the grant in ${startedBefore.length} samples`);
    expect(it, nginxStart && nginxStart.at >= granted.decided, `kong-supervisor started nginx at ${nginxStart?.at} before the grant at ${granted.decided}`);
    expect(it, admitted && nginxStart && admitted.at <= nginxStart.at, "nginx started before the probe adopted the admission");
    expect(it, nginxStart && nginxStart.at - granted.decided <= BUDGET.grantToNginx, `grant → nginx ${nginxStart?.at - granted.decided} ms > ${BUDGET.grantToNginx} ms`);
    expect(it, requestsBeforeGrant === 1, `${requestsBeforeGrant} admission requests before the grant (a cycle re-asks)`);
    // The instrument's own control: the same sampler does see nginx once the lease is out.
    negative(it, "the sampler sees nginx once the lease exists (instrument control)", "nginx > 0 after the grant", `first nginx sample ${firstNginx.start - granted.decided} ms after the grant`, firstNginx.start >= granted.decided);
    ctx.a1 = granted;
    writeFileSync(join(out, "item2-samples.json"), JSON.stringify(sampler.samples));

    await registration(it, pod, { agentLogs, granted, nginxStart });
    await capabilityTargets(it, pod);
  } finally {
    if (sampler.running) await sampler.stop();
  }
  done(it);
}

/** #172: the Workspaces cold start registers without Kong, once, with the version the pinned image itself carries. */
async function registration(it, pod, { agentLogs, granted, nginxStart }) {
  const spec = await json(["-n", NS.dp, "get", "pod", pod.name]);
  const agent = [...(spec.spec.initContainers ?? []), ...spec.spec.containers].find((c) => c.name === "agent");
  const env = Object.fromEntries((agent.env ?? []).map((e) => [e.name, e.value ?? "(valueFrom)"]));
  const tag = IMAGES.kong.split(":")[1];
  // The emptyDir seed-config wrote, read from the node: the agent's image has no shell.
  const file = await docker(["exec", spec.spec.nodeName, "cat", `/var/lib/kubelet/pods/${pod.uid}/volumes/kubernetes.io~empty-dir/kong-version/version`], { allowFail: true });
  const kong = await kubectl(["-n", NS.dp, "exec", pod.name, "-c", "kong", "--", "kong", "version"], { allowFail: true, timeout: 60_000 });
  const kongReports = /(\d+\.\d+\.\d+)/.exec(kong.stdout)?.[1] ?? null;
  const nodes = await sql(`select node_id, hostname, kong_version, agent_version from cluster_nodes where cluster_id = '${ctx.clusterId}'`);
  const authenticated = agentLogs.filter((l) => /node authenticated/.test(l.text));
  const failures = agentLogs.filter((l) => /registration failed/.test(l.text));
  const requested = firstLine(agentLogs, /admission requested/);
  const grantedLog = firstLine(agentLogs, /admission granted/);
  it.measures.registration = {
    kongTag: tag, agentEnv: { GROMESH_KONG_VERSION_FILE: env.GROMESH_KONG_VERSION_FILE ?? null, GROMESH_KONG_VERSION: env.GROMESH_KONG_VERSION ?? null },
    versionFile: file.code === 0 ? file.stdout : `unreadable: ${file.stderr.trim()}`, kongReports, cpNodes: nodes,
    authenticatedLines: authenticated.length, registrationFailures: failures.length,
    authenticatedToRequestedMs: authenticated[0] && requested ? requested.at - authenticated[0].at : null,
    authenticatedToNginxStartedMs: authenticated[0] && nginxStart ? nginxStart.at - authenticated[0].at : null,
    requestedToGrantedLogMs: requested && grantedLog ? grantedLog.at - requested.at : null,
  };
  expect(it, !/^\d+\.\d+\.\d+/.test(tag), `precondition: the Kong tag ${tag} starts with a version, so it cannot show the version comes from elsewhere`);
  expect(it, env.GROMESH_KONG_VERSION_FILE === "/gromesh/kong-version/version" && !("GROMESH_KONG_VERSION" in env), `agent env ${JSON.stringify(it.measures.registration.agentEnv)}`);
  expect(it, file.code === 0 && file.stdout === KONG_VERSION, `version file ${JSON.stringify(it.measures.registration.versionFile)}`);
  expect(it, kongReports === KONG_VERSION, `kong version answered ${kong.stdout.trim() || kong.stderr.trim()}`);
  expect(it, nodes.length === 1 && nodes[0].node_id === pod.name && nodes[0].kong_version === file.stdout, `cluster_nodes ${JSON.stringify(nodes)}`);
  expect(it, authenticated.length === 1 && failures.length === 0, `${authenticated.length} registrations, ${failures.length} registration failures`);
  expect(it, authenticated[0] && requested && grantedLog && nginxStart && authenticated[0].at <= requested.at && requested.at <= grantedLog.at && grantedLog.at <= nginxStart.at + 1_000,
    "order register → admission requested → granted → nginx not observed");
  expect(it, grantedLog && Math.abs(grantedLog.at - granted.decided) <= 5_000, "the agent's grant is not the control plane's");
}

/** CAP-6 and CAP-7 from the kong container: a target nothing listens on proves only that nothing listens. */
async function capabilityTargets(it, pod) {
  const seen = await loopbackTargets(pod.name);
  it.measures.loopbackTargets = seen;
  expect(it, /^HTTP\/1\.[01] 403/.test(seen["9100"] ?? ""), `CAP-6: the agent's :9100 answered ${seen["9100"]} to the kong container (403 expected)`);
  if (/connect connection refused/.test(seen["9880"] ?? "")) {
    it.notes.push("CAP-7: nothing listens on 127.0.0.1:9880, so the probe's check passes by refusal; reported as blocked");
    blocked({ id: "CAP-7", item: "2", missing: "a collector on the pod's loopback that accepts only the cluster token (the probe's CAP-7 check is refused, so it proves nothing)",
      component: "data plane chart / collector", pr: "none (the chart's collector is the cluster-wide Vector at gromesh-collector:8080)",
      unblock: "the chart ships the loopback collector; the suite then asserts 2xx with the cluster token and 401 without it, and the probe's check gets 401" });
  } else {
    expect(it, false, `something answers on 127.0.0.1:9880 (${seen["9880"]}): the suite must exercise the collector with and without its token`);
  }
}

/** Item 3: the reports reach the CP in order, at the round's cadence; the ack is the contiguous prefix, also facing a gap. */
async function reportsInOrder() {
  const it = item("3", "Reports reach the CP in order at the round cadence; ack contiguous, also with a gap (relay withholds n, delivers n+1)", {
    cadence: `consecutive reports received P ± ${s(BUDGET.cadenceTolerance)} apart (${s(P - BUDGET.cadenceTolerance)}–${s(P + BUDGET.cadenceTolerance)})`,
    ack: "highest contiguous seq: n withheld and n+1 delivered → ack n−1; n delivered → ack ≥ n+1", chain: "signatures, seq without gaps, prevDigest" });
  const a1 = ctx.a1;
  const id = a1.admission_id;
  const rows = await waitFor("four acked reports of pod 1", async () => ((await admissionRow(id)).acked_seq >= 4 ? reports(id) : null), { timeoutMs: 6 * P, intervalMs: 2000 });
  const first = rows.slice(0, 4);
  const gaps = first.slice(1).map((r, i) => r.received - first[i].received);
  const a = await admissionRow(id);
  const iso = await ctx.api.ok("GET", `/api/v2/clusters/${ctx.clusterId}/isolation`, { session: ctx.admin });
  const viewed = iso.pods.find((p) => p.admissionId === id);
  const probeKey = await probeKeyOf(id);
  Object.assign(it.measures, {
    reports: rows.length, ackedSeq: a.acked_seq, apiLastSeq: viewed?.lastSeq, apiState: viewed?.state, apiReporting: viewed?.reporting,
    states: [...new Set(rows.map((r) => r.state))], receivedGapsMs: gaps,
  });
  expect(it, a.acked_seq === rows.length && rows.at(-1).seq === rows.length, `acked ${a.acked_seq} of ${rows.length} contiguous reports`);
  expect(it, viewed && viewed.lastSeq >= a.acked_seq - 1 && viewed.reporting === "reporting", `getClusterIsolation: ${JSON.stringify(viewed)}`);
  expect(it, gaps.every((g) => Math.abs(g - P) <= BUDGET.cadenceTolerance), `received gaps ${gaps} ms outside P ± ${BUDGET.cadenceTolerance} ms`);
  const control = chainProblems(rows, probeKey, { wrongDigest: true });
  negative(it, "the chain check with a wrong digest (whole JWS hashed) must fail", "problems", `${control.length} problems`, control.length > 0);

  // The gap: the relay leaves out report n (not yet written) of every batch; n+1 then reaches the CP without n.
  const n = a.acked_seq + 2;
  await arm(id, n);
  mark("relay armed", { admissionId: id, withhold: n });
  let withGap;
  try {
    withGap = await waitFor(`report ${n + 1} delivered without ${n}`, async () => (await relayLog()).find((e) => e.admissionId === id && e.withheld === n && e.forwarded.includes(n + 1) && e.status === 200), { timeoutMs: 3 * P + 30_000, intervalMs: 2000 });
    const dbWithGap = (await admissionRow(id)).acked_seq;
    const stored = (await reports(id)).map((r) => r.seq).filter((x) => x >= n - 1);
    it.measures.gap = { withheld: n, forwarded: withGap.forwarded, ackWithGap: ackOf(withGap, id), rejected: withGap.rejected, dbAckedWithGap: dbWithGap, storedFromNMinus1: stored };
    negative(it, `ack past the gap (n = ${n} withheld, n+1 delivered)`, `ackedSeq ${n - 1}`, ackOf(withGap, id), ackOf(withGap, id) === n - 1);
    expect(it, dbWithGap === n - 1, `acked_seq ${dbWithGap} in the database while ${n} was missing`);
  } finally {
    await disarm();
  }
  mark("relay disarmed");
  const filled = await waitFor(`ack past ${n + 1} once ${n} arrives`, async () => (await relayLog()).find((e) => e.admissionId === id && e.at > withGap.at && !e.withheld && e.forwarded.includes(n) && ackOf(e, id) >= n + 1), { timeoutMs: 30_000, intervalMs: 1000 });
  const after = await reports(id);
  it.measures.gap.filled = { forwarded: filled.forwarded, ack: ackOf(filled, id), msAfterGap: filled.at - withGap.at };
  expect(it, ackOf(filled, id) >= n + 1, `ack ${ackOf(filled, id)} after ${n} arrived`);
  const problems = chainProblems(after, probeKey);
  it.measures.chainAfterGap = { reports: after.length, problems: problems.length };
  expect(it, problems.length === 0, `chain: ${problems.join("; ")}`);
  done(it);
}

/** Item 4: a second pod: its admission is held until the first pod's chain answers the current challenge. */
async function secondPod() {
  const it = item("4", "Second pod (scale 2): admission held until pod 1 answers the current challenge, then granted", {
    hold: "granted only after pod 1's acked report carries the request's challenge", latency: `request → grant ≤ P + T + 3 × agent interval + 2 s = ${s(BUDGET.heldGrant)}` });
  const known = new Set((await live()).map((p) => p.uid));
  await release("upgrade", [ctx.k1], 2);
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
    await waitFor("nginx in pod 2", async () => sampler.samples.some((x) => x.nginx > 0), { timeoutMs: BUDGET.grantToNginx + 30_000, intervalMs: 300 });
    await sampler.stop();
    const nginxBefore = sampler.samples.filter((x) => x.start < granted.decided && x.nginx > 0).length;
    Object.assign(it.measures, {
      requests: all.map((a) => ({ outcome: a.outcome, reason: a.reason, waitedMs: (a.decided ?? Date.now()) - a.requested })),
      requestToGrantMs: granted.decided - granted.requested,
      requestToAnswerReceivedMs: answer ? answer.received - granted.requested : null,
      answerToGrantMs: answer ? granted.decided - answer.received : null,
      answerSeq: answer?.seq, samplesBeforeGrant: sampler.samples.filter((x) => x.end < granted.decided).length, nginxBeforeGrant: nginxBefore,
    });
    expect(it, answer, "no report of pod 1 carries the granted request's challenge");
    expect(it, answer && answer.received <= granted.decided, "granted before pod 1's answer was received");
    expect(it, granted.decided - granted.requested <= BUDGET.heldGrant, `request → grant ${granted.decided - granted.requested} ms > ${BUDGET.heldGrant} ms`);
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
  const it = item("6", "Graceful deletion: kong exits first (crictl), then the probe's final pod-terminated report with kongStopConfirmed closes the admission", {
    order: "kong container finishedAt ≤ the probe's final report queued and ≤ the probe's and the agent's finishedAt; the CP receives the final report before the agent exits",
    kongExit: `kong container exited ≤ ${s(BUDGET.kongExit)} after the deletion`, podGone: `pod gone ≤ ${s(BUDGET.podGone)}`, replacement: `replacement request → grant ≤ ${s(BUDGET.heldGrant)}`,
    nginxServing: "with traffic: blocked until N3" });
  const pod = ctx.p1;
  const known = new Set((await live()).map((p) => p.uid));
  const status = await json(["-n", NS.dp, "get", "pod", pod.name]);
  const ids = Object.fromEntries([...(status.status.initContainerStatuses ?? []), ...(status.status.containerStatuses ?? [])]
    .filter((x) => ["kong", "isolation-probe", "agent"].includes(x.name)).map((x) => [x.name, x.containerID.replace(/^containerd:\/\//, "")]));
  const follow = Object.fromEntries(["isolation-probe", "agent"].map((c) => [c, new Follower(pod.name, c)]));
  followers.push(...Object.values(follow));
  const nginxNow = await kubectl(["-n", NS.dp, "exec", pod.name, "-c", "kong", "--", "sh", "-c", NGINX_SAMPLE], { timeout: 10_000 });
  const nginxAtDeletion = Number(nginxNow.stdout.trim().split(" ")[0]);
  const exits = watchExits(status.spec.nodeName, ids, 90);
  await sleep(1000);
  const t0 = Date.now();
  await kubectl(["-n", NS.dp, "delete", "pod", pod.name, "--wait=false"]);
  mark("graceful delete", { pod: pod.name, nginxAtDeletion });
  // NotFound is the only "gone"; any other kubectl failure aborts the item.
  for (;;) {
    const r = await kubectl(["-n", NS.dp, "get", "pod", pod.name, "--ignore-not-found", "-o", "json"]);
    if (!r.stdout.trim() || JSON.parse(r.stdout).metadata.uid !== pod.uid) break;
    if (Date.now() - t0 > 90_000) throw new Error("pod 1 still present 90 s after its deletion");
    await sleep(250);
  }
  const gone = Date.now();
  const term = await exits;
  await Promise.race([Promise.all(Object.values(follow).map((f) => f.closed)), sleep(5000)]);
  const closed = await waitFor("pod 1 admission closed", async () => { const a = await admissionRow(ctx.a1.admission_id); return a.state !== "open" ? a : null; }, { timeoutMs: 30_000 }).catch(() => null);
  const rows = await reports(ctx.a1.admission_id);
  const final = rows.at(-1);
  const probeFinal = firstLine(follow["isolation-probe"].lines, /final report of admission/);
  const f = Object.fromEntries(Object.entries(term.states).map(([k, v]) => [k, v.finishedAt]));
  Object.assign(it.measures, {
    nginxAtDeletion, deleteToPodGoneMs: gone - t0, containers: term.states,
    deleteToKongExitedMs: f.kong ? f.kong - t0 : null,
    kongExitedToProbeFinalLogMs: f.kong && probeFinal ? probeFinal.at - f.kong : null,
    deleteToProbeFinalLogMs: probeFinal ? probeFinal.at - t0 : null, probeFinalLog: probeFinal?.text,
    finalReport: final ? { seq: final.seq, final: final.final, finalReason: final.final_reason, kongStopConfirmed: final.kong_stop_confirmed, deleteToReceivedMs: final.received - t0, receivedToAgentExitedMs: f.agent ? f.agent - final.received : null } : null,
    admission: closed ? { state: closed.state, closeReason: closed.close_reason, deleteToClosedMs: closed.closed - t0 } : null,
  });
  expect(it, term.allExited && f.kong && f["isolation-probe"] && f.agent, `termination evidence (crictl): ${JSON.stringify(term.states)}`);
  expect(it, final?.final && final.final_reason === "pod-terminated" && final.kong_stop_confirmed === true, `last report ${JSON.stringify(it.measures.finalReport)}`);
  expect(it, closed?.state === "closed" && closed.close_reason === "kong-stop-confirmed", `admission ${JSON.stringify(it.measures.admission)}`);
  expect(it, f.kong && probeFinal && f.kong <= probeFinal.at, "the probe queued its final report before the kong container exited");
  expect(it, f.kong && f["isolation-probe"] && f.agent && f.kong <= f["isolation-probe"] && f.kong <= f.agent, `finishedAt ${JSON.stringify(f)}: a sidecar exited before kong`);
  expect(it, final && f.agent && final.received <= f.agent, "the agent exited before the CP received the final report");
  expect(it, f.kong && f.kong - t0 <= BUDGET.kongExit, `kong exited ${f.kong - t0} ms after the deletion`);
  expect(it, gone - t0 <= BUDGET.podGone, `pod took ${gone - t0} ms to disappear`);
  if (nginxAtDeletion === 0) it.notes.push("no nginx was running at the deletion (guard-missing until N3): only the container's exit was measured");
  ctx.p3 = await newPod(known);
  ctx.a3 = await waitFor("replacement pod admission granted", () => grantedOf(ctx.clusterId, ctx.p3.uid), { timeoutMs: 120_000 });
  it.measures.replacementRequestToGrantMs = ctx.a3.decided - ctx.a3.requested;
  expect(it, ctx.a3.decided - ctx.a3.requested <= BUDGET.heldGrant, `replacement request → grant ${ctx.a3.decided - ctx.a3.requested} ms > ${BUDGET.heldGrant} ms`);
  done(it);
}

/** The lease file the probe writes for the kong container: its state, or absent. */
async function leaseState(podName) {
  const r = await kubectl(["-n", NS.dp, "exec", podName, "-c", "kong", "--", "cat", "/gromesh/isolation/lease.json"], { allowFail: true, timeout: 10_000 });
  if (r.code !== 0) return /No such file/.test(r.stderr) ? "absent" : `unreadable: ${r.stderr.trim().slice(0, 120)}`;
  try { const { state } = JSON.parse(r.stdout); return typeof state === "string" ? state : "unparsable"; } catch { return "unparsable"; }
}
/** A lease observation that proves something: a state the probe wrote, or the file proven absent. */
const observed = (state) => !/^(unreadable|unparsable)/.test(state);
/** The probe's own chain head (probe-state.json): the last seq it numbered for `admissionId`, read from the kong container. */
async function probeSeq(podName, admissionId) {
  const r = await kubectl(["-n", NS.dp, "exec", podName, "-c", "kong", "--", "cat", "/gromesh/isolation/probe-state.json"], { timeout: 10_000 });
  const { chain } = JSON.parse(r.stdout);
  if (chain?.admissionId !== admissionId || !Number.isInteger(chain.seq)) throw new Error(`probe-state of ${podName} holds no chain of ${admissionId}`);
  return chain.seq;
}
const claimsOf = (row) => JSON.parse(Buffer.from(row.payload, "base64url"));

/**
 * The probe this run uses carries the F2 fix: the agent image (which ships the probe) is labelled with the revision it
 * was built from, on every worker, and that revision contains the fix commit and its source.
 */
const F2_FIX = "3b8bccb949987f70a2f2feee32685b75c3bd59fd";
async function f2Proof() {
  const labels = [];
  for (const node of NODES.workers) {
    const r = await docker(["exec", node, "crictl", "inspecti", "-o", "go-template", "--template", '{{index .info.imageSpec.config.Labels "org.opencontainers.image.revision"}}', IMAGES.agent], { allowFail: true });
    labels.push(r.code === 0 ? r.stdout.trim() : "");
  }
  const rev = labels[0];
  const proof = { image: IMAGES.agent, imageId: report.imageIds?.agent, revisionLabels: labels, fixCommit: F2_FIX, ancestor: false, sourceHasFix: false };
  if (!/^[0-9a-f]{40}$/.test(rev) || labels.some((l) => l !== rev)) return { ...proof, ok: false, why: "no single revision label on the agent image" };
  proof.ancestor = (await run("git", ["-C", root, "merge-base", "--is-ancestor", F2_FIX, rev], { allowFail: true })).code === 0;
  const source = await run("git", ["-C", root, "show", `${rev}:apps/isolation/internal/probe/round.go`], { allowFail: true });
  proof.sourceHasFix = source.code === 0 && source.stdout.includes('return "inconclusive", ch.URL + " connected without an answer: "');
  return { ...proof, ok: proof.ancestor && proof.sourceHasFix };
}

/** Item 9: the agent of a pod stopped: its chain goes silent, new admissions are held; nothing is a violation, and it resumes without a release. */
async function agentStopped() {
  const it = item("9", "Agent stopped (SIGSTOP), probe with the F2 fix: CAP-6 inconclusive (never violation), communication-failure, new admissions held; SIGCONT resumes without a release", {
    probe: "reports written during the stop carry CAP-6 in failedCapabilities with a state other than violation; the lease is never violation",
    communication: `communication-failure ${s(BUDGET.communication[0])}–${s(BUDGET.communication[1])} after the last report, never confirmed-violation (release refused: 409)`,
    resume: `the pendency closes chain-resumed with no release; resume → grant of the held pod ≤ P + T + 3 × agent interval + 2 s + the agent's refused backoff 30 s = ${s(BUDGET.resumeGrant)}`,
    ok: "back to ok and the 300 s inconclusive → no-proof window: blocked until N3 (see the blocked list)" });
  const silent = ctx.p2;
  const id = ctx.a2.admission_id;
  // p3 is deleted only once its chain is acked: a granted admission its probe never adopted stays open with no proof
  // and holds every new admission (see the findings), which would hide what this item measures.
  await waitFor("p3's chain acked", async () => (await admissionRow(ctx.a3.admission_id)).acked_seq >= 2, { timeoutMs: 3 * P + 30_000, intervalMs: 2000 });
  const known = new Set((await live()).map((p) => p.uid));
  const follower = new Follower(silent.name, "isolation-probe");
  followers.push(follower);
  const leaseBefore = await leaseState(silent.name);
  const before = (await reports(id)).at(-1);
  const target = await freeze(silent.name, "agent", "gromesh-agent");
  // The chain head the probe numbered when the agent stopped: reports after it, up to the head read just before the
  // SIGCONT, are the rounds written during the stop (a received time cannot tell them from rounds after the resume).
  const seqAtStop = await probeSeq(silent.name, id);
  let seqAtResume;
  const stopped = Date.now();
  mark("agent SIGSTOP", { pod: silent.name, pid: target.pid });
  await kubectl(["-n", NS.dp, "delete", "pod", ctx.p3.name, "--wait=false"]);
  const pod = await newPod(known);
  ctx.p4 = pod;
  // The lease as the kong container sees it, all along the stop.
  const leases = [];
  let sampling = true;
  const sampler = (async () => { while (sampling) { leases.push({ msAfterStop: Date.now() - stopped, state: await leaseState(silent.name) }); await sleep(5000); } })();
  let pendency;
  let whileStopped;
  let releaseAttempt;
  try {
    // Held past the decision window and past the communication-failure threshold.
    pendency = await waitFor("communication-failure for the silent admission", async () => (await pendencies(ctx.clusterId)).find((p) => p.admission_id === id && p.lifecycle === "communication-failure"), { timeoutMs: COMMUNICATION + 60_000, intervalMs: 2000 });
    await waitFor("a refused request of the new pod", async () => (await admissionOf(ctx.clusterId, pod.uid)).some((a) => a.outcome === "refused"), { timeoutMs: DECISION + 30_000, intervalMs: 2000 });
    whileStopped = await admissionOf(ctx.clusterId, pod.uid);
    releaseAttempt = await ctx.api.req("POST", `/api/v2/clusters/${ctx.clusterId}/isolation-releases`, { session: ctx.admin, body: { pendencyId: pendency.id, justification: "lab: communication-failure must not be releasable" } });
  } finally {
    sampling = false;
    await sampler;
    seqAtResume = await probeSeq(silent.name, id).catch((error) => { log(`probe seq before SIGCONT: ${error.message}`); return null; });
    it.measures.frozenAgent = await thaw(target);
  }
  const resumed = Date.now();
  mark("agent SIGCONT", { stoppedMs: resumed - stopped });
  negative(it, "release a communication-failure pendency (admin session+CSRF)", 409, releaseAttempt.status, releaseAttempt.status === 409);
  negative(it, "new pod granted while the agent is stopped", "no grant", whileStopped.map((a) => `${a.outcome}${a.reason ? `/${a.reason}` : ""}`).join(","), !whileStopped.some((a) => a.outcome === "granted"));
  const granted = await waitFor("new pod granted after the agent resumed", () => grantedOf(ctx.clusterId, pod.uid), { timeoutMs: BUDGET.resumeGrant + 30_000, intervalMs: 1000 });
  const closedPendency = await waitFor("the pendency closed after the resume", async () => { const p = (await pendencies(ctx.clusterId)).find((x) => x.id === pendency.id); return p.lifecycle !== "communication-failure" ? p : null; }, { timeoutMs: 60_000, intervalMs: 1000 }).catch(() => null);
  const rows = await reports(id);
  const during = rows.filter((r) => r.seq > before.seq).map((r) => ({ seq: r.seq, state: r.state, failed: claimsOf(r).failedCapabilities, received: r.received }));
  // The agent sends the backlog the instant it is continued, before thaw() returns: what reached the CP after the stop.
  const stoppedRounds = seqAtResume === null ? [] : during.filter((r) => r.seq > seqAtStop && r.seq <= seqAtResume);
  const allPendencies = (await pendencies(ctx.clusterId)).filter((p) => p.admission_id === id);
  const [{ n: releases }] = await sql(`select count(*)::int as n from isolation_releases where pendency_id = '${pendency.id}'`);
  const lastBefore = before.received;
  Object.assign(it.measures, {
    stoppedMs: resumed - stopped, stateBeforeStop: before.state, leaseBeforeStop: leaseBefore,
    leaseDuringStop: [...new Set(leases.map((l) => l.state))], leaseSamples: leases.length,
    lastReportToPendencyMs: pendency.opened - lastBefore,
    newPodRequestsWhileStopped: whileStopped.map((a) => ({ outcome: a.outcome, reason: a.reason })),
    reportsWrittenDuringStop: stoppedRounds.map((r) => `${r.seq}:${r.state}:${(r.failed ?? []).join("+")}`),
    pendenciesOfTheAdmission: allPendencies.map((p) => `${p.kind}/${p.lifecycle}${p.close_reason ? `/${p.close_reason}` : ""}`), releasesOfThePendency: releases,
    resumeToGrantMs: granted.decided - resumed,
    pendencyAfterResume: closedPendency ? { lifecycle: closedPendency.lifecycle, closeReason: closedPendency.close_reason, resumeToClosedMs: closedPendency.closed - resumed } : null,
    probeLogDuringStop: follower.lines.filter((l) => l.at >= stopped && l.at <= resumed + 2_000).map((l) => l.text).slice(0, 40),
  });
  expect(it, pendency.opened - lastBefore >= BUDGET.communication[0] && pendency.opened - lastBefore <= BUDGET.communication[1], `communication-failure ${pendency.opened - lastBefore} ms after the last report`);
  expect(it, stoppedRounds.length >= 2 && stoppedRounds.every((r) => r.state !== "violation"), `reports written during the stop: ${JSON.stringify(it.measures.reportsWrittenDuringStop)}`);
  expect(it, stoppedRounds.some((r) => (r.failed ?? []).includes("CAP-6")), "no report of the stop names CAP-6: the frozen agent's :9100 was not exercised");
  expect(it, leases.length > 0 && leases.every((l) => observed(l.state)), `the lease was not observed during the stop: ${JSON.stringify(it.measures.leaseDuringStop)}`);
  expect(it, !leases.some((l) => l.state === "violation"), `lease during the stop: ${JSON.stringify(it.measures.leaseDuringStop)}`);
  expect(it, !allPendencies.some((p) => p.kind === "confirmed-violation"), `pendencies of the admission: ${JSON.stringify(it.measures.pendenciesOfTheAdmission)}`);
  expect(it, closedPendency?.lifecycle === "closed" && closedPendency.close_reason === "chain-resumed" && releases === 0, `pendency after resume ${JSON.stringify(it.measures.pendencyAfterResume)}, ${releases} releases`);
  expect(it, chainProblems(rows, await probeKeyOf(id)).length === 0, "the chain across the stop is broken");
  expect(it, granted.decided - resumed <= BUDGET.resumeGrant, `resume → grant ${granted.decided - resumed} ms > ${BUDGET.resumeGrant} ms`);
  it.notes.push("before N3 a pod goes guard-missing 60 s after nginx starts (no canary route), so its state cycles verifying ↔ guard-missing: 'back to ok' and the 300 s inconclusive → no-proof window cannot be reached and are in the blocked list");
  blocked({ id: "9 (ok, no-proof)", item: "9", missing: "a pod in ok: the return to ok after SIGCONT and the 300 s inconclusive → no-proof window need a verified guard (an inconclusive round in guard-missing keeps guard-missing)",
    component: "compiler + agent (N3)", pr: "N3 (not opened)", unblock: "a serving pod with the guard canary: freeze its agent for > 300 s, expect no-proof and no lease; SIGCONT within the window, expect ok without a release" });
  ctx.a4 = granted;
  done(it);
}

/** Negative control of item 9: a real violation (a forbidden TCP target accepted) is still confirmed-violation and needs a release. */
async function violationControl() {
  const it = item("9-control", "Real violation (the allowed backend declared forbidden for one new pod): violation report, confirmed-violation, held until a release", {
    violation: "the new pod's report is violation with CAP-1; the CP opens confirmed-violation (releasable) and it stays open for 60 s with no release; a later request is refused pendency-open" });
  // No policy changes: the probe of pods created from now on also tries the allowed backend as a forbidden target, so
  // it is reached, which is exactly a forbidden target accepted. Running pods keep the configuration they loaded.
  const control = { capability: "CAP-1", kind: "tcp", name: "control: allowed backend declared forbidden", address: hostPort(ctx.topo.ext.backend.v4, 8080) };
  const checks = ctx.checks;
  ctx.checks = [...checks, control];
  try {
    await release("upgrade", [ctx.k1], 2);
  } finally {
    ctx.checks = checks;
  }
  mark("chart rollout with the control check");
  const known = new Set((await live()).map((p) => p.uid));
  const victim = (await live()).find((p) => p.uid === ctx.p4?.uid) ?? (await live())[0];
  // Deleted only once its chain is acked: an admission whose probe never adopted it stays open with no proof and
  // holds every new admission (item 5), which is not what this control is about.
  const victimAdmission = (await grantedOf(ctx.clusterId, victim.uid)).admission_id;
  await waitFor("the victim's chain acked", async () => (await admissionRow(victimAdmission)).acked_seq >= 2, { timeoutMs: 3 * P + 30_000, intervalMs: 2000 });
  await kubectl(["-n", NS.dp, "delete", "pod", victim.name, "--wait=false"]);
  const pod = await newPod(known);
  const granted = await waitFor("the control pod granted", () => grantedOf(ctx.clusterId, pod.uid), { timeoutMs: 120_000, intervalMs: 1000 });
  const violated = await waitFor("a violation report of the control pod", async () => (await reports(granted.admission_id)).find((r) => r.state === "violation"), { timeoutMs: 3 * P, intervalMs: 1000 });
  const pendency = await waitFor("confirmed-violation", async () => (await pendencies(ctx.clusterId)).find((p) => p.admission_id === granted.admission_id && p.lifecycle === "confirmed-violation"), { timeoutMs: 30_000, intervalMs: 1000 });
  await sleep(60_000);
  const after = (await pendencies(ctx.clusterId)).find((p) => p.id === pendency.id);
  const iso = await ctx.api.ok("GET", `/api/v2/clusters/${ctx.clusterId}/isolation`, { session: ctx.admin });
  const viewed = iso.pendencies.find((p) => p.id === pendency.id);
  const [{ n: releases }] = await sql(`select count(*)::int as n from isolation_releases where pendency_id = '${pendency.id}'`);
  // A later pod: refused while the confirmed violation is open.
  const known2 = new Set((await live()).map((p) => p.uid));
  const other = (await live()).find((p) => p.uid !== pod.uid);
  await kubectl(["-n", NS.dp, "delete", "pod", other.name, "--wait=false"]);
  const later = await newPod(known2);
  const refused = await waitFor("a later request refused pendency-open", async () => (await admissionOf(ctx.clusterId, later.uid)).find((a) => a.reason === "pendency-open"), { timeoutMs: 90_000, intervalMs: 1000 }).catch(() => null);
  const laterRequests = await admissionOf(ctx.clusterId, later.uid);
  Object.assign(it.measures, {
    violationReport: { seq: violated.seq, failed: claimsOf(violated).failedCapabilities }, lease: await leaseState(pod.name),
    pendency: { kind: pendency.kind, capability: pendency.capability, lifecycleAfter60s: after.lifecycle, releasable: viewed?.releasable, releases },
    laterRequests: laterRequests.map((a) => `${a.outcome}${a.reason ? `/${a.reason}` : ""}`),
  });
  negative(it, "a real violation (forbidden TCP target accepted)", "violation report with CAP-1 → confirmed-violation, open 60 s later, releasable, no release",
    JSON.stringify(it.measures.pendency), claimsOf(violated).failedCapabilities.includes("CAP-1") && after.lifecycle === "confirmed-violation" && viewed?.releasable === true && releases === 0);
  negative(it, "a later admission while the confirmed violation is open", "refused pendency-open", it.measures.laterRequests.join(","), Boolean(refused) && !laterRequests.some((a) => a.outcome === "granted"));
  expect(it, observed(it.measures.lease) && it.measures.lease !== "ok" && it.measures.lease !== "inconclusive", `the violating pod's lease: ${it.measures.lease}`);
  done(it);
}

/** Items 5 and 7: a pod killed before its final report; held, communication-failure, unconfirmed-isolation; CP restart keeps it; release. */
async function killedPod() {
  const it5 = item("5", "Pod deleted with its final report lost (agent frozen, then --grace-period=0 --force): admissions held, communication-failure, unconfirmed-isolation after 10 min, release by platform admin only", {
    communication: `${s(BUDGET.communication[0])}–${s(BUDGET.communication[1])} after the last report`, unconfirmed: `${s(BUDGET.unconfirmed[0])}–${s(BUDGET.unconfirmed[1])} after the last report`,
    release: "session + CSRF + justification, platform admin only" });
  const victim = ctx.p2;
  const known = new Set((await live()).map((p) => p.uid));
  // A force deletion alone still lets the native sidecars stop in order and deliver the final report (seen in this
  // lab: the admission closed with kongStopConfirmed 1 s later). A pod whose final report is lost is one whose agent
  // cannot carry it: freeze the agent first, then delete with no grace.
  const target = await freeze(victim.name, "agent", "gromesh-agent");
  const t0 = Date.now();
  await kubectl(["-n", NS.dp, "delete", "pod", victim.name, "--grace-period=0", "--force"], { allowFail: true });
  mark("agent frozen, then force delete", { pod: victim.name, agentPid: target.pid });
  const pod = await newPod(known);
  ctx.p5 = pod;
  await sleep(10_000);
  const rows = await reports(ctx.a2.admission_id);
  const finalArrived = rows.some((r) => r.final);
  it5.measures.finalReportReachedCp = finalArrived;
  expect(it5, !finalArrived, "a final report reached the control plane: the force deletion was not a SIGKILL before it");
  // Only after that check: a frozen agent that somehow outlived its pod must not deliver anything before it.
  it5.measures.frozenAgentAfterDeletion = await thaw(target);
  const lastReport = (await admissionRow(ctx.a2.admission_id)).last_report;
  const communication = await waitFor("communication-failure", async () => (await pendencies(ctx.clusterId)).find((p) => p.admission_id === ctx.a2.admission_id && p.lifecycle === "communication-failure"), { timeoutMs: COMMUNICATION + 60_000, intervalMs: 2000 });
  it5.measures.lastReportToCommunicationFailureMs = communication.opened - lastReport;
  it5.measures.killToLastReportMs = lastReport - t0;
  expect(it5, communication.opened - lastReport >= BUDGET.communication[0] && communication.opened - lastReport <= BUDGET.communication[1], `communication-failure ${communication.opened - lastReport} ms after the last report`);
  // While waiting for the 10 min: the new pod is held (refused by timeout, never granted).
  log(`waiting for unconfirmed-isolation (${Math.round((lastReport + UNCONFIRMED - Date.now()) / 1000)} s)`);
  await waitFor("unconfirmed-isolation", async () => {
    // getClusterIsolation runs the timers as the next decision would.
    const iso = await ctx.api.ok("GET", `/api/v2/clusters/${ctx.clusterId}/isolation`, { session: ctx.admin });
    return iso.pendencies.find((p) => p.id === communication.id && p.kind === "unconfirmed-isolation") ? (await pendencies(ctx.clusterId)).find((p) => p.id === communication.id) : null;
  }, { timeoutMs: UNCONFIRMED + 120_000, intervalMs: 5000 });
  const at = Date.now();
  const heldRequests = await admissionOf(ctx.clusterId, pod.uid);
  const [audit] = await sql(`select ${ms("at")} as at from audit_events where action = 'isolation.pendency.supersede' and entity_id = '${communication.id}' order by at limit 1`).catch(() => [null]);
  const supersededAt = audit ? local(audit.at) : at;
  it5.measures.lastReportToUnconfirmedMs = supersededAt - lastReport;
  it5.measures.unconfirmedInstant = audit ? "audit event" : "observed (no audit event found)";
  it5.measures.requestsDuringWait = heldRequests.map((a) => `${a.outcome}${a.reason ? `/${a.reason}` : ""}`);
  expect(it5, supersededAt - lastReport >= BUDGET.unconfirmed[0] && supersededAt - lastReport <= BUDGET.unconfirmed[1], `unconfirmed-isolation ${supersededAt - lastReport} ms after the last report`);
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
  const orphan = await admissionRow(ctx.a2.admission_id);
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
  const it = item("8", "Instance key revoked: new admissions → no-signing-key; chart rollout without the key → the probe drops the admission and its chain stops", {
    refuse: "refused no-signing-key", drop: `rollout → drop ≤ kubelet sync 60 s + ConfigMap cache 60 s + P = ${s(BUDGET.drop)}`,
    silence: `no report of the dropped admission received later than ${s(BUDGET.inFlight)} after the drop, sampled every 5 s for ${s(BUDGET.afterDrop)} and once more at the end` });
  const known = new Set((await live()).map((p) => p.uid));
  const revoke = await ctx.api.req("POST", `/api/v2/instance/signing-keys/${ctx.k1.kid}/revoke`, { token: ctx.adminToken, body: { justification: "lab N2-E2: revocation by token must fail" } });
  negative(it, "revoke the key with the admin's API token", "401 or 403", revoke.status, [401, 403].includes(revoke.status));
  const revoked = await ctx.api.ok("POST", `/api/v2/instance/signing-keys/${ctx.k1.kid}/revoke`, { session: ctx.admin, body: { justification: "lab N2-E2: instance key compromised (drill)" } });
  const revokedAt = Date.now();
  mark("key revoked", { kid: ctx.k1.kid, openAdmissions: revoked.openAdmissions });
  it.measures.openAdmissionsAtRevocation = revoked.openAdmissions;
  // Any admitted pod of the data plane: its replacement asks for an admission after the revocation.
  const current = await live();
  const victim = current.find((p) => p.uid === (ctx.p4 ?? ctx.p5)?.uid) ?? current[0];
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
  const id = ctx.a5.admission_id;
  const follower = new Follower(holder.name, "isolation-probe");
  followers.push(follower);
  await sleep(1000);
  const rollout = Date.now();
  await release("upgrade", [ctx.k2], 2);
  mark("chart rollout without the revoked key", { trustSet: [ctx.k2.kid] });
  const configMapName = (await json(["-n", NS.dp, "get", "configmap", "-l", "app.kubernetes.io/instance=dp"])).items.map((c) => c.metadata.name).find((n) => n.endsWith("isolation-probe"));
  const dropped = await waitFor("the probe drops the admission of the revoked key", async () => follower.lines.find((l) => l.at >= rollout && /no longer valid|not in the instance trust set/.test(l.text)), { timeoutMs: BUDGET.drop + 15_000, intervalMs: 1000 }).catch(() => null);
  it.measures.rolloutToDropMs = dropped ? dropped.at - rollout : null;
  it.measures.dropLog = dropped?.text;
  it.measures.configMap = configMapName;
  if (!expect(it, dropped, `the probe did not drop the admission within ${BUDGET.drop + 15_000} ms of the rollout`)) { done(it); return; }
  expect(it, dropped.at - rollout <= BUDGET.drop, `rollout → drop ${dropped.at - rollout} ms > ${BUDGET.drop} ms`);
  const seen = await kubectl(["-n", NS.dp, "exec", holder.name, "-c", "isolation-probe", "--", "/gromesh/isolation-bin/isolation-probe", "check-trust-set", "/etc/gromesh/instance-keys.json"], { allowFail: true });
  const lease = await kubectl(["-n", NS.dp, "exec", holder.name, "-c", "kong", "--", "sh", "-c", "test -e /gromesh/isolation/lease.json && echo present || echo absent"], { allowFail: true });
  it.measures.trustSetInPod = seen.stdout.trim() || seen.stderr.trim();
  it.measures.leaseAfterDrop = lease.stdout.trim();
  expect(it, lease.stdout.trim() === "absent", `lease after the drop: ${lease.stdout.trim()}`);

  // The silence after the drop, over the whole window: a single query right after the drop would prove nothing.
  const late = async () => (await reports(id)).filter((r) => r.received > dropped.at + BUDGET.inFlight);
  const samples = [];
  while (Date.now() < dropped.at + BUDGET.afterDrop) {
    samples.push({ msAfterDrop: Date.now() - dropped.at, late: (await late()).map((r) => r.seq) });
    await sleep(5000);
  }
  const finalLate = (await late()).map((r) => r.seq);
  const lastSeq = (await reports(id)).at(-1)?.seq;
  it.measures.afterDropSamples = { count: samples.length, spanMs: samples.at(-1)?.msAfterDrop ?? 0, withLateReports: samples.filter((x) => x.late.length).length, finalLate, lastSeq };
  expect(it, samples.length >= BUDGET.afterDrop / 5000 - 2 && samples.at(-1).msAfterDrop >= BUDGET.afterDrop - 6_000, `the window after the drop was not observed (${samples.length} samples)`);
  expect(it, samples.every((x) => x.late.length === 0) && finalLate.length === 0, `reports of the dropped admission after the drop: ${JSON.stringify(finalLate)}`);
  const holderRequests = await admissionOf(ctx.clusterId, ctx.p5.uid);
  const newRequests = await admissionOf(ctx.clusterId, pod.uid);
  const iso = await ctx.api.ok("GET", `/api/v2/clusters/${ctx.clusterId}/isolation`, { session: ctx.admin });
  const fmt = (a) => `${a.outcome}${a.reason ? `/${a.reason}` : ""}${a.kid ? `@${a.kid.slice(0, 8)}` : ""}`;
  it.measures.afterDrop = {
    holderRequests: holderRequests.map(fmt), newPodRequests: newRequests.map(fmt), pendencies: iso.pendencies.map((p) => p.kind),
    pods: iso.pods.filter((p) => p.admission !== "closed").map((p) => ({ pod: p.podName, admission: p.admission, reporting: p.reporting, state: p.state })),
  };
  done(it);
}

// What the suite cannot exercise yet. Each is listed as blocked with what unblocks it, never as passed.
// A step listed here runs, and counts, only when its proof holds; otherwise it is blocked (LAB_RUN_BLOCKED runs it as a
// diagnostic that stays blocked).
const BLOCKED_STEPS = {
  agentStopped: { id: "9", missing: "a probe with the F2 fix: without it a frozen agent's :9100 (connected, no answer) is a CAP-6 violation that latches the pod",
    component: "isolation-probe (apps/isolation/internal/probe/round.go)", pr: "#174 (task/N2-F2-inconclusive-http)",
    unblock: "an agent image labelled with a revision that contains 3b8bccb (the F2 fix), on every worker", proof: f2Proof },
};
const N3 = [
  { id: "n", missing: "traffic served behind the guard (the route guard canary answering 204 with the lease nonce)", component: "compiler + agent (v2 snapshot with the guard route)", pr: "N3 (not opened)", unblock: "the agent applies a v2 snapshot with the guard canary; pods leave guard-missing" },
  { id: "o", missing: "503 and Kong-stop budgets on a pod serving traffic (item 6 measures the exit of an nginx that serves nothing)", component: "compiler + agent (N3)", pr: "N3 (not opened)", unblock: "a serving pod: the suite measures the stop with nginx running" },
  { id: "p (part)", missing: "readiness Ready with the canary", component: "compiler + agent (N3)", pr: "N3 (not opened)", unblock: "the guard canary answers in a serving pod" },
];
const ITEM_OF = { reportsInOrder: "3", secondPod: "4", gracefulDeletion: "6", agentStopped: "9", killedPod: "5, 7", revocation: "8", violationControl: "9-control" };

/** Every secret this run created, looked for in every file it leaves: none may appear. */
function secretScan() {
  const secrets = [ctx.registrationToken, ctx.adminToken, ctx.editorToken, ctx.secrets?.pgPassword, ctx.secrets?.admin.password, ctx.secrets?.editor.password,
    ctx.secrets?.env.GROMESH_ENCRYPTION_KEY, ctx.secrets?.env.GROMESH_FINGERPRINT_KEY, ctx.admin?.cookie, ctx.admin?.csrf, ctx.editor?.cookie, ctx.editor?.csrf].filter(Boolean);
  const leaks = [];
  const files = readdirSync(out);
  for (const file of files) {
    const text = readFileSync(join(out, file), "utf8");
    secrets.forEach((secret, i) => { if (text.includes(secret)) leaks.push({ file, secret: i }); });
  }
  return { files, secrets: secrets.length, leaks };
}

async function diagnostics() {
  const parts = [];
  for (const ns of [NS.dp, NS.cp]) parts.push((await kubectl(["-n", ns, "get", "pods", "-o", "wide"], { allowFail: true })).stdout);
  for (const p of await pods().catch(() => [])) {
    for (const c of ["agent", "isolation-probe", "kong"]) parts.push(`--- ${p.name}/${c}\n${(await kubectl(["-n", NS.dp, "logs", "--timestamps", "--tail=200", p.name, "-c", c], { allowFail: true })).stdout}`);
  }
  parts.push(`--- relay\n${(await kubectl(["-n", NS.cp, "logs", "--tail=200", "deploy/cp-relay"], { allowFail: true })).stdout}`);
  writeFileSync(join(out, "diagnostics.log"), scrubKong(parts.join("\n")));
}

let finished = false;
async function finish() {
  if (finished) return;
  finished = true;
  report.thawed = await thawAll();
  for (const f of followers) f.stop();
  ctx.forward?.stop();
  if (report.items.some((i) => i.result === "fail") || report.aborted) await diagnostics().catch((error) => log(`diagnostics: ${error.message}`));
  if (!ctx.owned) report.cleanup = "nothing touched: the run stopped before the lab check and the preflight passed";
  else if (process.env.LAB_KEEP === "1") report.cleanup = "kept (LAB_KEEP=1)";
  else {
    await removeSuiteObjects().then(() => { report.cleanup = "namespaces and policies removed"; }, (error) => { report.cleanup = `failed: ${error.message}`; report.cleanupFailed = true; });
  }
  if (frozen.size) { report.cleanupFailed = true; report.stillFrozen = [...frozen]; }
  report.finishedAt = new Date().toISOString();
  save();
  report.secretScan = secretScan();
  save();
  log(`cleanup: ${report.cleanup}; secret scan: ${report.secretScan.leaks.length} leaks in ${report.secretScan.files.length} files`);
  console.log(`results: ${join(out, "results.json")}`);
}

async function main() {
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { report.aborted = { signal }; finish().finally(() => process.exit(130)); });
  const all = [setup, coldStart, reportsInOrder, secondPod, gracefulDeletion, agentStopped, killedPod, revocation, violationControl];
  // LAB_STEPS=<step,...> runs a subset in order (setup always first). violationControl leaves a confirmed violation
  // open, so it is never part of the default run.
  const chosen = (process.env.LAB_STEPS ?? "").split(",").filter(Boolean);
  const steps = chosen.length ? all.filter((st) => st === setup || chosen.includes(st.name)) : all.filter((st) => st !== violationControl);
  report.steps = steps.map((st) => st.name);
  const forced = new Set((process.env.LAB_RUN_BLOCKED ?? "").split(",").filter(Boolean));
  try {
    for (const step of steps) {
      let gate = BLOCKED_STEPS[step.name];
      if (gate?.proof && !ctx.blocked) {
        const proof = await gate.proof();
        report.proofs = { ...report.proofs, [step.name]: proof };
        if (proof.ok) gate = null;
      }
      const reason = (!forced.has(step.name) && gate) || ctx.blocked;
      if (reason) {
        const { proof, ...why } = reason;
        report.items.push({ title: step.name, result: "blocked", failures: [], ...why, id: ITEM_OF[step.name] ?? step.name });
        log(`step ${step.name}: BLOCKED (${reason.missing})`);
        continue;
      }
      const before = report.items.length;
      try {
        await step();
        // A blocked step run on request is diagnostic: whatever it measured, it stays blocked.
        if (forced.has(step.name) && gate) {
          for (const it of report.items.slice(before)) { const { proof, ...why } = gate; Object.assign(it, { diagnosticResult: it.result, result: "blocked", ...why, id: it.id }); }
        }
      } catch (error) {
        log(`step ${step.name} aborted: ${error.stack ?? error}`);
        for (const it of report.items.filter((i) => i.result === "pending")) { it.failures.push(`aborted: ${error.message}`); it.result = "fail"; }
        report.aborted = { step: step.name, error: String(error.message ?? error) };
        save();
        break;
      }
    }
    for (const entry of N3) blocked(entry);
  } finally {
    await finish();
  }
  const failed = report.items.filter((i) => i.result === "fail" || i.result === "pending");
  if (failed.length || report.aborted || report.secretScan.leaks.length || report.cleanupFailed) process.exit(1);
}

await main();
