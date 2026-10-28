#!/usr/bin/env node
// N2/N3 integrated v2 suite (lab only: Workspaces mode on only inside it). D4 flow: Publish Release (also with the mode
// off) → Create Deployment → Apply → Verify Convergence, then containment with the pod serving v2 (n, o, p, CAP-1…CAP-7,
// keepalive, WebSocket, hash and revision divergence, rollback). Needs the merged N3 stack in CP_IMAGE/AGENT_IMAGE and a
// host that does not saturate (e2e/kind/n2/external/run-all.sh); budgets are the contract's, never relaxed here.
//   LAB_KUBECONFIG=<file> CP_IMAGE=… AGENT_IMAGE=… KONG_IMAGE=… [LAB_OUT=<dir>] [LAB_STEPS=<step,…>] node e2e/kind/n2/components/v2.mjs
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
// Every image this suite pulls is pinned by digest in versions.env (a mutable tag would not reproduce the run).
const VERSIONS = Object.fromEntries(readFileSync(join(here, "../versions.env"), "utf8").split("\n")
  .filter((line) => /^[A-Z0-9_]+=/.test(line)).map((line) => line.split(/=(.*)/s).slice(0, 2)));
for (const key of ["PG_IMAGE", "CLICKHOUSE_IMAGE", "VECTOR_IMAGE", "FIXTURE_IMAGE"]) {
  if (!/@sha256:[0-9a-f]{64}$/.test(VERSIONS[key] ?? "")) throw new Error(`versions.env: ${key} is not pinned by digest`);
}
const IMAGES = {
  cp: process.env.CP_IMAGE ?? "gromesh-n2c-cp:41db8aa",
  agent: process.env.AGENT_IMAGE ?? "gromesh-n2c-agent:13e340c",
  // The lab's Kong (ghcr.io/grometis/gromesh-kong@sha256:786d736c…) re-tagged locally: the tag carries no version.
  kong: process.env.KONG_IMAGE ?? "gromesh-n2c-kong:786d736c",
  pg: process.env.PG_IMAGE ?? VERSIONS.PG_IMAGE,
};
const FIXTURE_IMAGE = VERSIONS.FIXTURE_IMAGE;
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


// =====================================================================================================================
// N2/N3 integrated v2 flow (lab only, not committed): real CP (N3-C3/C4 + F3), real agent and probe (N3-C5 + F3),
// chart with the collector sidecar (N2-X4) and GROMESH_INSTANCE_ID (N3-C5b). Workspaces mode on only here
// (GROMESH_EXPERIMENTAL_WORKSPACES=lab, stage dev). Every instant measured below is on the Docker VM's clock
// (log timestamps, the client pod, `date` on a kind node): intervals never mix it with this host's clock.
const ctx = {};
const followers = [];
const OBS = "gromesh-n2-obs";
const BACKEND_PORT = 8081;
const CLICKHOUSE_IMAGE = VERSIONS.CLICKHOUSE_IMAGE;
const [VECTOR_NAME, VECTOR_DIGEST] = VERSIONS.VECTOR_IMAGE.split("@");
// Budgets for the workloads the suite adds next to the data plane, so they cannot starve the node it measures on.
const FIXTURE_RESOURCES = {
  clickhouse: { requests: { cpu: "250m", memory: "512Mi" }, limits: { cpu: "1", memory: "1536Mi" } },
  validator: { requests: { cpu: "100m", memory: "256Mi" }, limits: { cpu: "500m", memory: "512Mi" } },
};
const V2_BUDGET = { detection: 18_000, block503: 19_000, kongStopSupervisor: 20_000, kongStopLiveness: 24_000, notReady: 20_000,
  probeDown503: 34_000, probeDownStopSupervisor: 35_000, probeDownStopIndependent: 39_000, drainSignal: 1_000, drainExit: 20_000 };
report.v2Budgets = V2_BUDGET;
const vm = { loads: [] };
const vmNow = async () => Number((await docker(["exec", NODES.workers[0], "date", "+%s%3N"])).stdout.trim());
async function vmLoad(label) {
  const { stdout } = await docker(["exec", NODES.cp, "cat", "/proc/loadavg"]);
  const one = Number(stdout.split(" ")[0]);
  vm.loads.push({ label, one, at: new Date().toISOString() });
  report.vmLoads = vm.loads;
  return one;
}
const vmTime = (rfc3339) => Date.parse(rfc3339.replace(/(\.\d{3})\d*Z$/, "$1Z"));
async function vmLogs(pod, container, extra = []) {
  const { stdout } = await kubectl(["-n", NS.dp, "logs", "--timestamps", ...extra, pod, "-c", container], { allowFail: true });
  return stdout.split("\n").filter(Boolean).map((l) => { const i = l.indexOf(" "); return { at: vmTime(l.slice(0, i)), text: l.slice(i + 1) }; });
}

const CAP7 = { capability: "CAP-7", kind: "http", name: "collector sidecar on loopback, no token", url: "http://127.0.0.1:8080/kong", expectStatus: 401, method: "POST" };

const valuesV2 = (keys, replicas, { clickhousePeers } = {}) => ({
  replicaCount: replicas,
  kong: { image: { repository: IMAGES.kong.split(":")[0], tag: IMAGES.kong.split(":")[1], digest: "", pullPolicy: "Never" } },
  agent: { image: { repository: IMAGES.agent.split(":")[0], tag: IMAGES.agent.split(":")[1], digest: "", pullPolicy: "Never" },
    controlPlaneUrl: RELAY_URL, existingSecret: "dp-registration" },
  networkPolicy: {
    enabled: true,
    controlPlanePeers: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": NS.cp } }, podSelector: { matchLabels: { app: "cp-relay" } } }],
    upstreams: [{ cidr: `${ctx.topo.ext.backend.v4}/32`, ports: [8080, BACKEND_PORT] }, { cidr: `${ctx.topo.ext.backend.v6}/128`, ports: [8080, BACKEND_PORT] }],
    clickhousePeers: clickhousePeers ?? [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": OBS } }, podSelector: { matchLabels: { app: "clickhouse" } } }],
  },
  workspaces: { enabled: true, clusterId: ctx.clusterId, instanceId: ctx.instanceId, instanceSigningKeys: keys, probe: { checks: ctx.checks } },
  collector: { enabled: true, mode: "sidecar", clusterId: ctx.clusterId, environmentId: ctx.instanceId,
    image: { repository: VECTOR_NAME.split(":")[0], tag: VECTOR_NAME.split(":")[1], digest: VECTOR_DIGEST, pullPolicy: "IfNotPresent" },
    clickhouse: { endpoint: `http://clickhouse.${OBS}.svc.cluster.local:8123`, existingSecret: "clickhouse-writer" } },
});
const releaseV2 = (verb, keys, replicas, opts) => helm([verb, "dp", CHART, "-n", NS.dp, "-f", "-"], { input: JSON.stringify(valuesV2(keys, replicas, opts)) });

// The backend behind both workspaces' routes: HTTP (echoes who Kong says the consumer is) and a minimal WebSocket echo.
const BACKEND = String.raw`
const http = require("node:http"); const crypto = require("node:crypto");
const s = http.createServer((q, r) => { r.setHeader("content-type", "application/json");
  r.end(JSON.stringify({ path: q.url, consumer: q.headers["x-consumer-username"] ?? null, workspace: q.headers["x-gromesh-workspace"] ?? null })); });
s.keepAliveTimeout = 120000;
s.on("upgrade", (q, sock) => {
  const accept = crypto.createHash("sha1").update(q.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  let buf = Buffer.alloc(0);
  sock.on("data", (d) => { buf = Buffer.concat([buf, d]);
    while (buf.length >= 6) { const len = buf[1] & 127; if (len > 125 || buf.length < 6 + len) break;
      const mask = buf.subarray(2, 6); const payload = Buffer.from(buf.subarray(6, 6 + len)).map((b, i) => b ^ mask[i % 4]); buf = buf.subarray(6 + len);
      const out = Buffer.from("pong " + payload.toString().slice(5)); sock.write(Buffer.concat([Buffer.from([0x81, out.length]), out])); } });
  sock.on("error", () => {});
});
s.listen(${BACKEND_PORT}, "::");`;

// The traffic client, inside the unrestricted observer pod: one new connection per request, one keepalive socket,
// one WebSocket; every event is a JSON line stamped with the pod's (VM) clock.
const CLIENT = String.raw`
import http from "node:http"; import net from "node:net"; import crypto from "node:crypto";
const [host, port, path, key, wsPath] = JSON.parse(globalThis.ARGS);
const log = (o) => console.log(JSON.stringify({ t: Date.now(), ...o }));
const ka = new http.Agent({ keepAlive: true, maxSockets: 1 });
function get(kind, agent) {
  const q = http.request({ host, port, path, agent, headers: { apikey: key }, timeout: 3000 }, (r) => { r.resume(); r.on("end", () => log({ k: kind, s: r.statusCode, reused: q.reusedSocket })); });
  q.on("timeout", () => q.destroy(new Error("timeout"))); q.on("error", (e) => log({ k: kind, e: e.code ?? e.message })); q.end();
}
setInterval(() => get("new", false), 250);
setInterval(() => get("ka", ka), 250);
function ws() {
  const sock = net.connect(Number(port), host); let open = false, n = 0, buf = "";
  sock.on("connect", () => sock.write("GET " + wsPath + " HTTP/1.1\r\nHost: " + host + "\r\napikey: " + key + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " + crypto.randomBytes(16).toString("base64") + "\r\n\r\n"));
  sock.on("data", (d) => { if (!open) { buf += d.toString("latin1"); if (buf.includes("\r\n\r\n")) { const st = buf.split(" ")[1]; open = st === "101"; log({ k: "ws", ev: open ? "open" : "refused", s: Number(st) }); if (!open) sock.destroy(); } return; }
    if (d.toString().includes("pong")) log({ k: "ws", ev: "pong" }); });
  const timer = setInterval(() => { if (!open) return; const p = Buffer.from("ping " + (++n)); const m = crypto.randomBytes(4); sock.write(Buffer.concat([Buffer.from([0x81, 0x80 | p.length]), m, p.map((b, i) => b ^ m[i % 4])])); }, 500);
  sock.on("close", () => { clearInterval(timer); log({ k: "ws", ev: "close" }); setTimeout(ws, 1000); });
  sock.on("error", (e) => log({ k: "ws", ev: "error", e: e.code }));
}
ws();`;

let Client = class {
  constructor(label, args) {
    this.events = [];
    this.child = spawn("kubectl", ["--kubeconfig", kubeconfig, "--context", CONTEXT, "-n", NS.fx, "exec", "-i", "observer", "--", "node", "--input-type=module", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin.end(`globalThis.ARGS = ${JSON.stringify(JSON.stringify(args))};\n${CLIENT}`);
    let buffer = "";
    this.child.stdout.on("data", (d) => { buffer += d; const parts = buffer.split("\n"); buffer = parts.pop(); for (const l of parts) { try { this.events.push(JSON.parse(l)); } catch { /* partial */ } } });
    this.label = label;
  }
  async stop() {
    this.child.kill("SIGKILL");
    await kubectl(["-n", NS.fx, "exec", "observer", "--", "sh", "-c", "pkill -f 'input-type=module' || true"], { allowFail: true });
  }
  since(t) { return this.events.filter((e) => e.t >= t); }
}

async function proxyService() {
  const svcs = (await json(["-n", NS.dp, "get", "svc"])).items;
  const s = svcs.find((x) => x.spec.ports.some((p) => p.targetPort === 8000 || p.port === 8000 || p.name === "proxy"));
  const port = s.spec.ports.find((p) => p.targetPort === 8000 || p.port === 8000 || p.name === "proxy");
  return { host: `${s.metadata.name}.${NS.dp}.svc.cluster.local`, port: port.port, name: s.metadata.name };
}
/** One request from the observer pod through the proxy Service. */
async function call(path, key) {
  // The key travels on stdin (never in argv, which errors and process listings show).
  const script = `const [url, key] = JSON.parse(${JSON.stringify(JSON.stringify([`http://${ctx.proxy.host}:${ctx.proxy.port}${path}`, key ?? ""]))}); const r = await fetch(url, { headers: key ? { apikey: key } : {}, signal: AbortSignal.timeout(5000) }).catch((e) => ({ status: 0, text: async () => String(e.cause?.code ?? e) })); console.log(JSON.stringify({ s: r.status, b: (await r.text()).slice(0, 300) }));`;
  const { stdout } = await kubectl(["-n", NS.fx, "exec", "-i", "observer", "--", "node", "--input-type=module", "-"], { input: script, timeout: 30_000 });
  return JSON.parse(stdout.trim());
}

async function chq(query) {
  const { stdout } = await kubectl(["exec", "-n", OBS, "deploy/clickhouse", "--", "sh", "-c", 'clickhouse-client -u admin --password "$CLICKHOUSE_PASSWORD" -q "$1"', "sh", query], { timeout: 60_000 });
  return stdout.trim();
}
async function clickhouse() {
  const admin = randomUUID().replaceAll("-", "");
  ctx.chWriter = randomUUID().replaceAll("-", "");
  await apply([{ apiVersion: "v1", kind: "Namespace", metadata: { name: OBS } },
    { apiVersion: "v1", kind: "Secret", metadata: { name: "ch", namespace: OBS }, stringData: { admin } },
    { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "schema", namespace: OBS }, data: {
      "001-requests.sql": readFileSync(join(root, "deploy/observability/clickhouse/001-requests.sql"), "utf8"),
      "002-retention.sql": readFileSync(join(root, "deploy/observability/clickhouse/002-retention.sql"), "utf8") } },
    { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "clickhouse", namespace: OBS }, spec: { replicas: 1,
      selector: { matchLabels: { app: "clickhouse" } }, template: { metadata: { labels: { app: "clickhouse" } }, spec: { nodeName: NODES.cp, tolerations: [{ operator: "Exists" }], containers: [{
        name: "clickhouse", image: CLICKHOUSE_IMAGE, imagePullPolicy: "IfNotPresent",
        env: [{ name: "CLICKHOUSE_DB", value: "gromesh" }, { name: "CLICKHOUSE_USER", value: "admin" },
          { name: "CLICKHOUSE_PASSWORD", valueFrom: { secretKeyRef: { name: "ch", key: "admin" } } }, { name: "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT", value: "1" }],
        resources: FIXTURE_RESOURCES.clickhouse,
        ports: [{ containerPort: 8123 }], volumeMounts: [{ name: "schema", mountPath: "/docker-entrypoint-initdb.d" }] }],
      volumes: [{ name: "schema", configMap: { name: "schema" } }] } } } },
    { apiVersion: "v1", kind: "Service", metadata: { name: "clickhouse", namespace: OBS }, spec: { selector: { app: "clickhouse" }, ports: [{ port: 8123 }] } }]);
  await waitFor("clickhouse schema", async () => (await chq("SELECT count() FROM gromesh.requests")) !== undefined, { timeoutMs: 300_000, intervalMs: 3000 });
  await kubectl(["exec", "-i", "-n", OBS, "deploy/clickhouse", "--", "sh", "-c", 'clickhouse-client -u admin --password "$CLICKHOUSE_PASSWORD" -n'],
    { input: `CREATE USER IF NOT EXISTS gromesh_writer IDENTIFIED WITH sha256_password BY '${ctx.chWriter}'; GRANT INSERT ON gromesh.requests TO gromesh_writer;` });
}

function validatorObjects() {
  const labels = { app: "kong-validator" };
  return [
    { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "kong-validator", namespace: NS.cp, labels }, spec: { replicas: 1, selector: { matchLabels: labels },
      template: { metadata: { labels }, spec: { nodeName: NODES.cp, tolerations: [{ operator: "Exists" }], automountServiceAccountToken: false, containers: [{ name: "kong", image: IMAGES.kong, imagePullPolicy: "Never",
        env: [{ name: "KONG_DATABASE", value: "off" }, { name: "KONG_PROXY_LISTEN", value: "off" }, { name: "KONG_ADMIN_LISTEN", value: "0.0.0.0:8001" }, { name: "KONG_STATUS_LISTEN", value: "0.0.0.0:8100" },
          { name: "KONG_ADMIN_ACCESS_LOG", value: "off" }, { name: "KONG_NGINX_WORKER_PROCESSES", value: "1" }, { name: "KONG_PLUGINS", value: "bundled,gromesh-workspace,gromesh-route-guard" }],
        resources: FIXTURE_RESOURCES.validator,
        readinessProbe: { httpGet: { path: "/status", port: 8100 }, periodSeconds: 2 } }] } } } },
    { apiVersion: "v1", kind: "Service", metadata: { name: "kong-validator", namespace: NS.cp }, spec: { selector: labels, ports: [{ port: 8001 }] } },
  ];
}

async function deploymentState(revision) {
  const rows = await sql(`select state, reason, ${ms("at")} as at from deployment_states where epoch = 1 and revision = ${Number(revision)} order by seq`);
  return rows;
}
async function nodesOf() {
  return sql(`select node_id, evidence, kong_config_hash, verified_revision, deployment_hash, failure_reason, ${ms("last_seen_at")} as seen from cluster_nodes where cluster_id = '${ctx.clusterId}' order by node_id`).catch(async () =>
    sql(`select node_id, evidence, kong_config_hash, verified_revision, deployment_hash, failure_reason from cluster_nodes where cluster_id = '${ctx.clusterId}' order by node_id`));
}
const clusterProtocol = async () => (await sql(`select delivery_protocol from clusters where id = '${ctx.clusterId}'`))[0].delivery_protocol;
async function handoffApplied(pod) {
  const p = await json(["-n", NS.dp, "get", "pod", pod.name]);
  const r = await docker(["exec", p.spec.nodeName, "cat", `/var/lib/kubelet/pods/${p.metadata.uid}/volumes/kubernetes.io~empty-dir/isolation-handoff/applied.json`], { allowFail: true });
  return r.code === 0 ? JSON.parse(r.stdout) : null;
}
async function latestReport(pod) {
  const g = await grantedOf(ctx.clusterId, pod.uid);
  if (!g) return null;
  const [row] = await sql(`select seq, payload, state from isolation_reports where admission_id = '${g.admission_id}' order by seq desc limit 1`);
  return row ? { seq: row.seq, state: row.state, claims: JSON.parse(Buffer.from(row.payload, "base64url")) } : null;
}
const podReady = (p) => (p.conditions ?? []).find((c) => c.type === "Ready")?.status === "True";

/** Setup: CP (C3/C4/F3) with Workspaces mode off (D4: d4Disabled turns it on), validator, ClickHouse, two workspaces with content. */
async function setupV2() {
  const it = item("V2-setup", "CP from the integration tree with Workspaces mode off (stage dev), validator, ClickHouse, backend HTTP/WS, two workspaces", { note: "setup" });
  report.environment = await assertLab();
  await vmLoad("setup start");
  const topo = await topology();
  ctx.topo = topo;
  ctx.checks = [...probeChecks(topo).filter((c) => c.capability !== "CAP-7"), CAP7];
  ctx.owned = true;
  await removeSuiteObjects();
  await kubectl(["delete", "namespace", OBS, "--ignore-not-found", "--wait", "--timeout=240s"], { timeout: 260_000 });
  const secrets = cpSecrets();
  ctx.secrets = secrets;
  await apply([{ apiVersion: "v1", kind: "Namespace", metadata: { name: NS.cp } }]);
  await createSecret(controlPlaneSecret(secrets));
  const cpObjects = controlPlaneObjects({ cpImage: IMAGES.cp, pgImage: IMAGES.pg });
  for (const o of cpObjects) if (o.kind === "Deployment" && o.metadata.name === "control-plane") o.spec.template.spec.containers[0].env.push(
    { name: "KONG_VALIDATOR_URL", value: `http://kong-validator.${NS.cp}.svc.cluster.local:8001` },
    { name: "GROMESH_INSTANCE_STAGE", value: "dev" },
    { name: "PLATFORM_HTTP_LOG_ENDPOINT", value: "http://127.0.0.1:8080/kong" });
  await apply([...cpObjects, ...validatorObjects()]);
  await apply(relayObjects({ image: FIXTURE_IMAGE, source: readFileSync(join(here, "relay.mjs"), "utf8") }));
  for (const d of ["postgres", "kong-validator", "control-plane", "cp-relay"]) await kubectl(["-n", NS.cp, "rollout", "status", `deployment/${d}`, "--timeout=240s"], { timeout: 260_000 });
  ctx.forward = new Forward(Number(process.env.LAB_CP_PORT ?? 39301));
  ctx.api = new Api(ctx.forward);
  await waitFor("control plane /healthz", async () => (await ctx.api.req("GET", "/healthz")).status === 200, { timeoutMs: 120_000 });
  skew = (await dbSkew()).skew;
  const { api } = ctx;
  ctx.admin = await api.login(secrets.admin.email, secrets.admin.password);
  await api.ok("POST", "/api/v1/users", { session: ctx.admin, body: { email: secrets.editor.email, name: "Editor do lab", role: "editor", password: secrets.editor.password } });
  ctx.editor = await api.login(secrets.editor.email, secrets.editor.password);
  const envA = await api.ok("POST", "/api/v1/environments", { session: ctx.admin, body: { name: "n2-lab" } });
  const envB = await api.ok("POST", "/api/v1/environments", { session: ctx.admin, body: { name: "n2-lab-b" } });
  const cluster = await api.ok("POST", `/api/v1/environments/${envA.id}/clusters`, { session: ctx.admin, body: { name: "n2-lab-dp" } });
  ctx.clusterId = cluster.id;
  ctx.registrationToken = cluster.registrationToken;
  const validUntil = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const k1 = await api.ok("POST", "/api/v2/instance/signing-keys", { session: ctx.admin, body: { validUntil } });
  ctx.k1 = { kid: k1.kid, publicKey: k1.publicKey };
  // The backend: HTTP + WebSocket on the allowed external fixture, beside its TCP servers.
  await docker(["exec", "-d", "gromesh-n2-lab-fx-backend", "node", "-e", BACKEND]);
  await clickhouse();
  await apply([{ apiVersion: "v1", kind: "Namespace", metadata: { name: NS.dp } }, ...denyPolicies(topo.net),
    { apiVersion: "v1", kind: "Secret", metadata: { name: "clickhouse-writer", namespace: NS.dp }, stringData: { "writer-password": ctx.chWriter } }]);
  await createSecret(registrationSecret(ctx.registrationToken));

  // Content: the same shape in both workspaces, keys generated by the server.
  ctx.ws = {};
  for (const [label, env] of [["A", envA], ["B", envB]]) {
    const svc = await api.ok("POST", `/api/v1/environments/${env.id}/services`, { session: ctx.admin, body: { name: "svc", protocol: "http", host: topo.ext.backend.v4, port: BACKEND_PORT } });
    const route = await api.ok("POST", `/api/v1/environments/${env.id}/routes`, { session: ctx.admin, body: { name: "r", serviceId: svc.id, paths: ["/api"], stripPath: false } });
    await api.ok("POST", `/api/v1/environments/${env.id}/plugins`, { session: ctx.admin, body: { name: "key-auth", scope: { routeId: route.id }, config: {} } });
    const consumer = await api.ok("POST", `/api/v1/environments/${env.id}/consumers`, { session: ctx.admin, body: { username: "app" } });
    const cred = await api.ok("POST", `/api/v1/environments/${env.id}/consumers/${consumer.id}/key-auth`, { session: ctx.admin, body: {} });
    secretsSeen.push(cred.key);
    ctx.ws[label] = { id: env.id, key: cred.key, routeId: route.id, serviceId: svc.id };
  }
  const list = await api.ok("GET", "/api/v2/workspaces", { session: ctx.admin });
  for (const w of Object.values(ctx.ws)) w.slug = (list.items ?? list).find((x) => x.id === w.id)?.slug;
  Object.assign(it.measures, { clusterId: ctx.clusterId, slugs: Object.fromEntries(Object.entries(ctx.ws).map(([k, v]) => [k, v.slug])) });
  expect(it, ctx.ws.A.slug && ctx.ws.B.slug, "workspace slugs");
  await vmLoad("setup end");
  done(it);
}
const secretsSeen = [];

const problemCode = (res) => res.body?.code ?? String(res.body?.type ?? "").split("/").pop();

/** D4 with Workspaces mode off: a validated release is created, nothing reaches the data plane; deploy and switch refused. */
async function d4Disabled() {
  const it = item("V2-d4-disabled", "Mode off (default): publishRelease creates a validated immutable release and no deployment; createDeployment and the switch to v2 refused 409 workspaces-mode-disabled; the cluster stays v1; then the lab turns the mode on explicitly", {
    rule: "D4: the operational block is on deployment and activation, never indiscriminately on release creation" });
  const { api } = ctx;
  const rel = await api.req("POST", `/api/v2/workspaces/${ctx.ws.A.id}/releases`, { session: ctx.admin, body: { message: "lab: release with the mode off" } });
  expect(it, rel.status === 201, `publishRelease with the mode off: ${rel.status} ${JSON.stringify(rel.body)}`);
  const deployments = await sql("select count(*)::int as n from deployments");
  expect(it, deployments[0].n === 0, `a release with the mode off created ${deployments[0].n} deployments`);
  const dep = await api.req("POST", "/api/v2/deployments", { session: ctx.admin, body: { expectedRevision: null, reason: "lab: mode off" } });
  negative(it, "createDeployment with the mode off", "409 workspaces-mode-disabled", `${dep.status} ${problemCode(dep)}`, dep.status === 409 && problemCode(dep) === "workspaces-mode-disabled");
  const sw = await api.req("PUT", `/api/v2/clusters/${ctx.clusterId}/delivery-protocol`, { session: ctx.admin, body: { protocol: "v2", reason: "lab: mode off" } });
  negative(it, "setClusterDeliveryProtocol v2 with the mode off", "409 workspaces-mode-disabled", `${sw.status} ${problemCode(sw)}`, sw.status === 409 && problemCode(sw) === "workspaces-mode-disabled");
  const protocol = await clusterProtocol();
  expect(it, protocol === "v1", `cluster protocol with the mode off: ${protocol}`);
  it.measures.releaseVersion = rel.body?.version ?? null;
  // The explicit, lab-only switch: the control plane restarts with the experimental mode on.
  await kubectl(["-n", NS.cp, "set", "env", "deployment/control-plane", "GROMESH_EXPERIMENTAL_WORKSPACES=lab"]);
  await kubectl(["-n", NS.cp, "rollout", "status", "deployment/control-plane", "--timeout=240s"], { timeout: 260_000 });
  await ctx.forward.start();
  await waitFor("control plane /healthz after the mode switch", async () => (await api.req("GET", "/healthz")).status === 200, { timeoutMs: 120_000 });
  ctx.admin = await api.login(ctx.secrets.admin.email, ctx.secrets.admin.password);
  ctx.editor = await api.login(ctx.secrets.editor.email, ctx.secrets.editor.password);
  mark("workspaces mode on (lab)");
  done(it);
}

/** Publish (freeze only), deploy, switch the cluster to v2, install the chart; converge with evidence `verified`. */
async function convergeV2() {
  const it = item("V2-converge", "publishRelease only freezes; createDeployment composes; setClusterDeliveryProtocol v2-pending; the gate opens with admitted pods; the agent applies the JCS string; Kong confirms the md5; applied.json; the probe reports applied*; the CP converges with evidence verified", {
    rule: "no delivery before v2; a declared revision alone never converges; every expected node verified" });
  const { api } = ctx;
  const releases = {};
  for (const [label, w] of Object.entries(ctx.ws)) releases[label] = await api.ok("POST", `/api/v2/workspaces/${w.id}/releases`, { session: ctx.admin, body: { message: `lab ${label}` } });
  const before = await sql("select count(*)::int as n from deployments");
  expect(it, before[0].n === 0, `publishRelease created ${before[0].n} deployments`);
  // Negative controls once there is something to deploy, so a refusal can only be the permission.
  const edDeploy = await api.req("POST", "/api/v2/deployments", { session: ctx.editor, body: { expectedRevision: null, reason: "lab" } });
  negative(it, "createDeployment as editor", 403, edDeploy.status, edDeploy.status === 403);
  const edSwitch = await api.req("PUT", `/api/v2/clusters/${ctx.clusterId}/delivery-protocol`, { session: ctx.editor, body: { protocol: "v2", reason: "lab" } });
  negative(it, "setClusterDeliveryProtocol as editor", 403, edSwitch.status, edSwitch.status === 403);
  const dep = await api.ok("POST", "/api/v2/deployments", { session: ctx.admin, body: { expectedRevision: null, reason: "lab: first v2 deployment" } });
  ctx.dep1 = dep;
  // getInstance is still planned: the instance row (D1) exists once the first release is published.
  ctx.instanceId = (await sql("select id from instance"))[0].id;
  it.measures.instanceId = ctx.instanceId;
  // A revision that is not the current one (the schema takes integers >= 1 or null).
  const stale = await api.req("POST", "/api/v2/deployments", { session: ctx.admin, body: { expectedRevision: dep.revision + 1, reason: "lab: stale expectedRevision" } });
  negative(it, "createDeployment with a stale expectedRevision", 409, stale.status, stale.status === 409);
  const sw = await api.ok("PUT", `/api/v2/clusters/${ctx.clusterId}/delivery-protocol`, { session: ctx.admin, body: { protocol: "v2", reason: "lab: N2/N3 integrated run" } });
  it.measures.afterSwitch = sw.deliveryProtocol;
  const t0 = Date.now();
  await releaseV2("install", [ctx.k1], 2);
  mark("helm install v2", { revision: dep.revision, kongConfigHash: dep.kongConfigHash });
  await waitFor("cluster v2 (activation gate)", async () => (await clusterProtocol()) === "v2", { timeoutMs: 300_000, intervalMs: 2000 });
  it.measures.installToV2Ms = Date.now() - t0;
  const converged = await waitFor("deployment converged", async () => (await deploymentState(dep.revision)).find((s) => s.state === "converged"), { timeoutMs: 300_000, intervalMs: 2000 }).catch(() => null);
  it.measures.installToConvergedMs = converged ? Date.now() - t0 : null;
  it.measures.states = (await deploymentState(dep.revision)).map((s) => s.state);
  const nodes = await nodesOf();
  it.measures.nodes = nodes;
  const ps = await live();
  it.measures.pods = [];
  for (const p of ps) {
    const applied = await handoffApplied(p);
    const rep = await latestReport(p);
    const pj = await json(["-n", NS.dp, "get", "pod", p.name]);
    it.measures.pods.push({ pod: p.name, ready: podReady(pj.status), applied: applied && { revision: applied.revision, epoch: applied.epoch, kongConfigHash: applied.kongConfigHash, hash: applied.hash, instanceId: applied.instanceId === ctx.instanceId },
      report: rep && { state: rep.state, served: rep.claims.servedKongConfigHash, appliedRevision: rep.claims.appliedRevision, failed: rep.claims.failedCapabilities } });
  }
  expect(it, converged, `not converged: ${JSON.stringify(it.measures.states)}`);
  expect(it, nodes.length >= 2 && nodes.every((n) => n.evidence === "verified" && n.kong_config_hash === dep.kongConfigHash), `nodes not all verified: ${JSON.stringify(nodes)}`);
  for (const p of it.measures.pods) {
    expect(it, p.ready, `${p.pod} not Ready`);
    expect(it, p.applied?.kongConfigHash === dep.kongConfigHash && p.applied?.revision === dep.revision, `${p.pod} applied.json ${JSON.stringify(p.applied)}`);
    expect(it, p.report?.served === dep.kongConfigHash && p.report?.appliedRevision === dep.revision, `${p.pod} probe report ${JSON.stringify(p.report)}`);
  }
  done(it);
}

/** Traffic: each workspace's consumer only on its own route; CAP-1..CAP-7 conclusive and passing with Kong serving. */
async function trafficV2() {
  const it = item("V2-traffic", "Kong serving v2: A's key on A's route 200 with A's consumer; B's key on A's route 401 (as an invalid key); no key 401; CAP-1..CAP-7 passing with the pod serving; collector events reach ClickHouse", {});
  ctx.proxy = await proxyService();
  const A = `/${ctx.ws.A.slug}/api`, B = `/${ctx.ws.B.slug}/api`;
  const m = {
    AA: await call(A, ctx.ws.A.key), AB: await call(A, ctx.ws.B.key), BB: await call(B, ctx.ws.B.key), BA: await call(B, ctx.ws.A.key),
    Anokey: await call(A), Ainvalid: await call(A, "not-a-key-of-anyone-0000000000"),
  };
  it.measures.matrix = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { s: v.s, b: v.b.slice(0, 160) }]));
  expect(it, m.AA.s === 200 && m.BB.s === 200, `own keys: ${m.AA.s} ${m.BB.s}`);
  negative(it, "B's key on A's route", 401, m.AB.s, m.AB.s === 401);
  negative(it, "A's key on B's route", 401, m.BA.s, m.BA.s === 401);
  negative(it, "cross key answers exactly like an invalid key", m.Ainvalid.s, m.AB.s, m.AB.s === m.Ainvalid.s && m.AB.b === m.Ainvalid.b);
  negative(it, "no key", 401, m.Anokey.s, m.Anokey.s === 401);
  const caps = [];
  for (const p of await live()) { const r = await latestReport(p); caps.push({ pod: p.name, state: r?.state, failed: r?.claims.failedCapabilities, served: r?.claims.servedKongConfigHash }); }
  it.measures.capabilities = caps;
  expect(it, caps.every((c) => c.state === "ok" && Array.isArray(c.failed) && c.failed.length === 0), `rounds not all ok/passing with Kong serving: ${JSON.stringify(caps)}`);
  const rows = await waitFor("collector rows in ClickHouse", async () => { const n = Number(await chq(`SELECT count() FROM gromesh.requests WHERE environment_id = '${ctx.instanceId}'`)); return n > 0 ? n : null; }, { timeoutMs: 90_000, intervalMs: 5000 }).catch(() => 0);
  it.measures.clickhouseRows = rows;
  expect(it, rows > 0, "no analytics rows from the collector sidecar");
  done(it);
}

const first = (events, pred) => events.find(pred) ?? null;
const rel = (t, t0) => (t == null ? null : t - t0);
async function endpointsReady() {
  const list = (await json(["-n", NS.dp, "get", "endpointslices", "-l", `kubernetes.io/service-name=${ctx.proxy.name}`])).items;
  return list.flatMap((s) => (s.endpoints ?? []).filter((e) => e.conditions?.ready).map((e) => e.targetRef?.name)).filter(Boolean);
}
/** Samples (VM clock) of every pod's Ready condition and the Service's ready endpoints until `ms` have passed. */
async function sampleReadiness(ms) {
  const samples = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = await vmNow();
    const pods = (await json(["-n", NS.dp, "get", "pods", "-l", SELECTOR])).items.map((p) => ({ name: p.metadata.name, ready: podReady(p.status), kongRestarts: p.status.containerStatuses?.find((c) => c.name === "kong")?.restartCount ?? 0 }));
    const eps = await endpointsReady().catch(() => null);
    samples.push({ t, pods, eps });
    await sleep(250);
  }
  return samples;
}
async function kongExit(pod, t0) {
  const lines = await vmLogs(pod, "kong");
  const prev = await vmLogs(pod, "kong", ["--previous"]).catch(() => []);
  const all = [...prev, ...lines].filter((l) => l.at >= t0);
  const stop = first(all, (l) => /lease invalid.*stopping nginx/.test(l.text));
  const exited = first(all, (l) => /nginx \(pid \d+\) exited/.test(l.text));
  const pj = await json(["-n", NS.dp, "get", "pod", pod]);
  const kc = pj.status.containerStatuses?.find((c) => c.name === "kong");
  const term = kc?.lastState?.terminated ?? kc?.state?.terminated ?? null;
  return { stopLog: stop?.at ?? null, exitedLog: exited?.at ?? null, containerFinished: term?.finishedAt ? Date.parse(term.finishedAt) : null, containerExitCode: term?.exitCode ?? null, restarts: kc?.restartCount ?? 0 };
}

/** Recovery after a contained violation: policies back, pendencies released by the platform admin, the contained pods
 * replaced (the probe's violation latch survives in the pod), then the deployment converges again. */
async function recover(it, why) {
  await apply(denyPolicies(ctx.topo.net));
  const open = (await pendencies(ctx.clusterId)).filter((p) => ["communication-failure", "confirmed-violation", "unconfirmed-isolation"].includes(p.lifecycle));
  for (const p of open.filter((x) => x.lifecycle !== "communication-failure")) {
    const r = await ctx.api.req("POST", `/api/v2/clusters/${ctx.clusterId}/isolation-releases`, { session: ctx.admin, body: { pendencyId: p.id, justification: `lab N2/N3: ${why}` } });
    expect(it, r.status === 201, `release ${p.id}: ${r.status}`);
  }
  const t0 = Date.now();
  const before = await live();
  const known = new Set(before.map((p) => p.uid));
  for (const p of before) await kubectl(["-n", NS.dp, "delete", "pod", p.name, "--wait=false"]);
  await waitFor("replacement pods Ready", async () => { const ps = (await json(["-n", NS.dp, "get", "pods", "-l", SELECTOR])).items.filter((p) => !p.metadata.deletionTimestamp && !known.has(p.metadata.uid)); return ps.length >= before.length && ps.every((p) => podReady(p.status)); }, { timeoutMs: 300_000, intervalMs: 2000 }).catch(() => null);
  const nodes = await nodesOf();
  const stale = nodes.filter((n) => !(n.evidence === "verified"));
  it.measures[`recovery(${why})`] = { replaceToReadyMs: Date.now() - t0, staleNodesBeforeContour: stale.map((n) => ({ node: n.node_id, evidence: n.evidence })) };
  // Known gap (no deregistration yet): the deleted pods' nodes stay expected and hold the convergence; lab contour only.
  const liveNames = new Set((await live()).map((p) => p.name));
  const gone = nodes.filter((n) => !liveNames.has(n.node_id)).map((n) => n.node_id);
  if (gone.length) {
    await sql(`with d as (delete from cluster_nodes where cluster_id = '${ctx.clusterId}' and node_id in (${gone.map((g) => `'${g}'`).join(",")}) returning 1) select count(*)::int as n from d`).catch((e) => it.notes.push(`stale node contour failed: ${e.message}`));
    it.notes.push(`lab contour: removed ${gone.length} cluster_nodes rows of deleted pods (no deregistration exists yet)`);
  }
}

/** Aceite n: fail-closed by a real loss of isolation with the pod serving, keepalive and WebSocket open. */
async function containmentN({ frozenSupervisor = false } = {}) {
  const id = frozenSupervisor ? "V2-n-frozen-supervisor" : "V2-n";
  const it = item(id, frozenSupervisor
    ? "Loss of isolation with the supervisor frozen (kill -STOP PID 1 of kong): Kong stopped by the liveness ≤ 24 s, WebSocket gone ≤ 24 s"
    : "Loss of isolation (cluster-wide IMDS deny removed) with continuous traffic, keepalive and WebSocket: detection ≤ 18 s, 503 ≤ 19 s, Kong stopped ≤ 20 s, NotReady ≤ 20 s, endpoints removal measured", V2_BUDGET);
  const client = new Client(id, [ctx.proxy.host, String(ctx.proxy.port), `/${ctx.ws.A.slug}/api`, ctx.ws.A.key, `/${ctx.ws.A.slug}/api/ws`]);
  await sleep(6000);
  const warm = client.events.slice(-40);
  it.measures.warmup = { ok: warm.filter((e) => e.s === 200).length, ws: client.events.filter((e) => e.k === "ws").map((e) => e.ev).slice(0, 4) };
  expect(it, warm.some((e) => e.k === "new" && e.s === 200) && warm.some((e) => e.k === "ka" && e.s === 200), "no 200 before the loss");
  expect(it, client.events.some((e) => e.k === "ws" && e.ev === "pong"), "the WebSocket never echoed before the loss");
  const pods = await live();
  if (frozenSupervisor) for (const p of pods) await freeze(p.name, "kong", "kong-supervisor");
  const loadStart = await vmLoad(`${id} start`);
  await kubectl(["delete", "ciliumclusterwidenetworkpolicy", "n2c-deny-imds"]);
  const t0 = await vmNow();
  mark("isolation lost", { at: t0, policy: "n2c-deny-imds" });
  const samples = await sampleReadiness(frozenSupervisor ? 45_000 : 40_000);
  const loadEnd = await vmLoad(`${id} end`);
  await thawAll();
  await sleep(1500);
  await client.stop();
  const ev = client.since(t0);
  const per = [];
  for (const p of pods) {
    const probe = first(await vmLogs(p.name, "isolation-probe"), (l) => l.at >= t0 && /violation of .*containment/.test(l.text));
    const k = await kongExit(p.name, t0);
    const notReady = first(samples, (s) => s.pods.find((x) => x.name === p.name)?.ready === false);
    const outOfEndpoints = first(samples, (s) => s.eps && !s.eps.includes(p.name));
    per.push({ pod: p.name, detectionMs: rel(probe?.at, t0), kongStopLogMs: rel(k.stopLog, t0), kongExitedLogMs: rel(k.exitedLog, t0), kongContainerFinishedMs: rel(k.containerFinished, t0), kongRestarts: k.restarts, notReadyMs: rel(notReady?.t, t0), endpointsRemovalMs: rel(outOfEndpoints?.t, t0) });
  }
  const first503 = first(ev, (e) => e.k === "new" && e.s === 503);
  const last200new = [...ev].reverse().find((e) => e.k === "new" && e.s === 200);
  const ka503 = first(ev, (e) => e.k === "ka" && e.s === 503);
  const wsClose = first(ev, (e) => e.k === "ws" && e.ev === "close");
  const wsLastPong = [...ev].reverse().find((e) => e.k === "ws" && e.ev === "pong");
  Object.assign(it.measures, { vmLoad: { start: loadStart, end: loadEnd }, pods: per, first503NewMs: rel(first503?.t, t0), last200NewMs: rel(last200new?.t, t0), first503KeepaliveMs: rel(ka503?.t, t0),
    wsCloseMs: rel(wsClose?.t, t0), wsLastPongMs: rel(wsLastPong?.t, t0), statuses: Object.entries(ev.reduce((a, e) => { const k = `${e.k}:${e.s ?? e.ev ?? e.e}`; a[k] = (a[k] ?? 0) + 1; return a; }, {})) });
  const worstDetect = Math.max(...per.map((p) => p.detectionMs ?? Infinity));
  if (!frozenSupervisor) {
    expect(it, worstDetect <= V2_BUDGET.detection, `detection ${worstDetect} ms`);
    expect(it, first503 && first503.t - t0 <= V2_BUDGET.block503 + 0, `first 503 at ${it.measures.first503NewMs} ms`);
    expect(it, per.every((p) => (p.kongExitedLogMs ?? Infinity) <= V2_BUDGET.kongStopSupervisor), `Kong stopped (supervisor) ${JSON.stringify(per.map((p) => p.kongExitedLogMs))}`);
    expect(it, per.every((p) => (p.notReadyMs ?? Infinity) <= V2_BUDGET.notReady), `NotReady ${JSON.stringify(per.map((p) => p.notReadyMs))}`);
    expect(it, wsClose && wsClose.t - t0 <= V2_BUDGET.kongStopSupervisor, `WebSocket closed at ${it.measures.wsCloseMs} ms`);
  } else {
    expect(it, per.every((p) => (p.kongContainerFinishedMs ?? Infinity) <= V2_BUDGET.kongStopLiveness + 1000), `Kong stopped by the liveness ${JSON.stringify(per.map((p) => p.kongContainerFinishedMs))} (finishedAt has 1 s resolution)`);
    expect(it, wsClose && wsClose.t - t0 <= V2_BUDGET.kongStopLiveness, `WebSocket closed at ${it.measures.wsCloseMs} ms`);
    // K: what the kubelet and runtime added beyond detection + Lp + Lt + G.
    it.measures.K = per.map((p) => (p.kongContainerFinishedMs == null || p.detectionMs == null ? null : p.kongContainerFinishedMs - p.detectionMs - 1000 - 1000 - 2000));
  }
  if (loadEnd > 16) it.notes.push(`VM load ${loadEnd} > 16 during the measurement: repeat`);
  ctx.lastViolation = id;
  await recover(it, id);
  done(it);
}

/** Aceite o: the probe stopped (kill -STOP) on one pod: 503 ≤ 34 s and Kong stopped ≤ 35/39 s from the last lease. */
async function probeDown() {
  const it = item("V2-o-probe-down", "Probe frozen on one serving pod: lease not renewed; 503 on that pod and Kong stopped within the lease budget; the other pod keeps serving; recovery after SIGCONT", V2_BUDGET);
  const [p] = await live();
  const leaseLines = async () => (await vmLogs(p.name, "isolation-probe")).filter((l) => /round report|lease/.test(l.text));
  const before = await leaseLines();
  const loadStart = await vmLoad("probe-down start");
  const target = await freeze(p.name, "isolation-probe", "isolation-probe");
  const t0 = await vmNow();
  const lastRound = before.at(-1)?.at ?? null;
  const samples = await sampleReadiness(45_000);
  const k = await kongExit(p.name, t0);
  const notReady = first(samples, (s) => s.pods.find((x) => x.name === p.name)?.ready === false);
  const loadEnd = await vmLoad("probe-down end");
  await thaw(target);
  const back = await waitFor("pod Ready again after SIGCONT", async () => { const pj = await json(["-n", NS.dp, "get", "pod", p.name]); return podReady(pj.status) ? await vmNow() : null; }, { timeoutMs: 180_000, intervalMs: 1000 }).catch(() => null);
  Object.assign(it.measures, { vmLoad: { start: loadStart, end: loadEnd }, lastProbeLineBeforeFreezeMs: rel(lastRound, t0), kongStopLogMs: rel(k.stopLog, t0), kongExitedLogMs: rel(k.exitedLog, t0), notReadyMs: rel(notReady?.t, t0), readyAgainAfterThawMs: back ? back - t0 : null });
  // The lease is valid 33 s after its write; the last write precedes the freeze, so from the freeze the bound is ≤ 35 s.
  expect(it, k.exitedLog && k.exitedLog - t0 <= V2_BUDGET.probeDownStopSupervisor, `Kong stopped ${it.measures.kongExitedLogMs} ms after the freeze`);
  expect(it, back, "the pod did not come back after SIGCONT");
  if (loadEnd > 16) it.notes.push(`VM load ${loadEnd} > 16: repeat`);
  done(it);
}

/** Aceite o: the agent frozen on a serving pod (communication failure): no containment of a pod that proves isolation. */
async function agentDown() {
  const it = item("V2-o-agent-down", "Agent frozen 90 s on a serving pod: no 503 and no Kong stop (the probe keeps proving isolation), communication-failure opened, closed on SIGCONT without a release", {});
  const client = new Client("agent-down", [ctx.proxy.host, String(ctx.proxy.port), `/${ctx.ws.A.slug}/api`, ctx.ws.A.key, `/${ctx.ws.A.slug}/api/ws`]);
  await sleep(4000);
  const [p] = await live();
  const target = await freeze(p.name, "agent", "gromesh-agent");
  const t0 = await vmNow();
  await sleep(90_000);
  const pend = (await pendencies(ctx.clusterId)).filter((x) => x.lifecycle === "communication-failure");
  await thaw(target);
  const closed = await waitFor("communication-failure closed", async () => (await pendencies(ctx.clusterId)).filter((x) => x.lifecycle === "communication-failure").length === 0, { timeoutMs: 120_000, intervalMs: 2000 }).catch(() => false);
  await client.stop();
  const ev = client.since(t0);
  const k = await kongExit(p.name, t0);
  Object.assign(it.measures, { non200: ev.filter((e) => (e.k === "new" || e.k === "ka") && e.s !== 200).length, total: ev.filter((e) => e.k === "new" || e.k === "ka").length,
    wsClosed: ev.some((e) => e.k === "ws" && e.ev === "close"), kongStopped: Boolean(k.stopLog), communicationFailureOpened: pend.length, closedWithoutRelease: closed });
  expect(it, it.measures.non200 === 0, `${it.measures.non200} non-200 answers while the agent was frozen`);
  expect(it, !it.measures.kongStopped, "Kong stopped while only the agent was frozen");
  expect(it, closed, "communication-failure did not close after SIGCONT");
  done(it);
}

// Posts to the pod's own Kong (admin socket, inside the kong container) the config it serves plus one trailing
// newline: same entities, different bytes, so a different configuration_hash. Kong's admin API is only on the socket.
const DIVERGE = String.raw`local unix = require "socket.unix"
local function req(m, p, b) local c = unix(); assert(c:connect("/kong/admin/admin.sock")); c:settimeout(15)
  c:send(m .. " " .. p .. " HTTP/1.0\r\nHost: k\r\nContent-Type: application/json\r\nContent-Length: " .. (b and #b or 0) .. "\r\n\r\n" .. (b or ""))
  local r = c:receive("*a"); c:close(); return r end
local r = req("GET", "/config")
local body = r:match("\r\n\r\n(.*)$")
local nb = body:gsub('"}%s*$', '\\n"}')
local res = req("POST", "/config", nb)
print((res:match("^[^\r]*")))`;

/** Served config ≠ authorized revision: the canary shows it, the pod leaves ok, the CP evidence diverges, and the agent
 * restores the authorized bytes (or the probe withdraws the lease after 60 s). */
async function hashDivergence() {
  const it = item("V2-hash-divergence", "Kong of one pod fed a different config through its admin socket: the canary's hash differs from applied.json → verifying (NotReady); CP evidence leaves verified; the authorized config is restored and the node converges again", {});
  const [p] = await live();
  const t0 = await vmNow();
  const { stdout } = await kubectl(["-n", NS.dp, "exec", p.name, "-c", "kong", "--", "luajit", "-e", DIVERGE], { timeout: 60_000 });
  it.measures.post = stdout.trim();
  const evid = [];
  const end = Date.now() + 100_000;
  while (Date.now() < end) { const n = (await nodesOf()).find((x) => x.node_id === p.name); const pj = await json(["-n", NS.dp, "get", "pod", p.name]); evid.push({ t: await vmNow(), evidence: n?.evidence, ready: podReady(pj.status) }); await sleep(2000); }
  const probe = await vmLogs(p.name, "isolation-probe");
  const agent = await vmLogs(p.name, "agent");
  const verifying = first(probe, (l) => l.at >= t0 && /canary serves configuration .*: verifying/.test(l.text));
  const reverified = first(probe, (l) => l.at > (verifying?.at ?? t0) && /guard verified on configuration/.test(l.text));
  const guardMissing = first(probe, (l) => l.at >= t0 && /guard-missing/.test(l.text));
  const notReady = first(evid, (e) => e.ready === false);
  const diverged = first(evid, (e) => e.evidence && e.evidence !== "verified");
  const backVerified = diverged ? first(evid, (e) => e.t > diverged.t && e.evidence === "verified") : null;
  Object.assign(it.measures, { verifyingMs: rel(verifying?.at, t0), notReadyMs: rel(notReady?.t, t0), cpEvidence: [...new Set(evid.map((e) => e.evidence))], divergedMs: rel(diverged?.t, t0), reverifiedMs: rel(reverified?.at, t0),
    cpVerifiedAgainMs: rel(backVerified?.t, t0), guardMissingMs: rel(guardMissing?.at, t0), agentLines: agent.filter((l) => l.at >= t0).map((l) => l.text).slice(0, 8) });
  expect(it, /200|201/.test(it.measures.post), `the divergent config was not accepted by Kong: ${it.measures.post}`);
  expect(it, verifying, "the probe did not see the divergent hash");
  expect(it, notReady, "the pod stayed Ready while serving an unauthorized config");
  expect(it, diverged && /divergence|mismatch|awaiting/.test(diverged.evidence), `CP evidence never left verified: ${JSON.stringify(it.measures.cpEvidence)}`);
  expect(it, backVerified || guardMissing, "neither restored nor contained");
  done(it);
}

/** applied.json claiming a revision the CP never authorized for that hash: the CP never counts it as converged. */
async function revisionMismatch() {
  const it = item("V2-revision-mismatch", "applied.json rewritten with another revision (same hash): the probe reports it (canary hash matches), the CP evidence leaves verified (revision mismatch); restored → verified", {});
  const [p] = await live();
  const pj = await json(["-n", NS.dp, "get", "pod", p.name]);
  const dir = `/var/lib/kubelet/pods/${pj.metadata.uid}/volumes/kubernetes.io~empty-dir/isolation-handoff`;
  const original = (await docker(["exec", pj.spec.nodeName, "cat", `${dir}/applied.json`])).stdout;
  const forged = JSON.stringify({ ...JSON.parse(original), revision: JSON.parse(original).revision + 7 });
  const write = (bytes) => docker(["exec", "-i", pj.spec.nodeName, "sh", "-c", `cat > ${dir}/.a && chown --reference=${dir}/applied.json ${dir}/.a && chmod --reference=${dir}/applied.json ${dir}/.a && mv ${dir}/.a ${dir}/applied.json`], { input: bytes });
  const t0 = await vmNow();
  await write(forged);
  const seen = await waitFor("CP evidence leaves verified", async () => { const n = (await nodesOf()).find((x) => x.node_id === p.name); return n?.evidence !== "verified" ? n : null; }, { timeoutMs: 90_000, intervalMs: 2000 }).catch(() => null);
  const t1 = await vmNow();
  const rep = await latestReport(p);
  await write(original);
  const back = await waitFor("verified again", async () => { const n = (await nodesOf()).find((x) => x.node_id === p.name); return n?.evidence === "verified" ? await vmNow() : null; }, { timeoutMs: 120_000, intervalMs: 2000 }).catch(() => null);
  Object.assign(it.measures, { evidence: seen?.evidence ?? null, detectedMs: seen ? t1 - t0 : null, probeReportAppliedRevision: rep?.claims.appliedRevision, verifiedAgainMs: back ? back - t0 : null });
  negative(it, "a forged applied revision counted as converged", "evidence ≠ verified", seen?.evidence ?? "verified", Boolean(seen));
  expect(it, back, "not verified again after restoring applied.json");
  done(it);
}

/** Lab rollback: a change, then the previous content again as a new revision: same config hash, converges. */
async function rollbackV2() {
  const it = item("V2-rollback", "Revision 2 changes A (new route); revision 3 restores the previous content: config hash equal to revision 1, converged with every node verified; B's members digest unchanged throughout", {});
  const { api } = ctx;
  const A = ctx.ws.A;
  const extra = await api.ok("POST", `/api/v1/environments/${A.id}/routes`, { session: ctx.admin, body: { name: "r2", serviceId: A.serviceId, paths: ["/v2"], stripPath: false } });
  await api.ok("POST", `/api/v2/workspaces/${A.id}/releases`, { session: ctx.admin, body: { message: "lab: r2" } });
  const d2 = await api.ok("POST", "/api/v2/deployments", { session: ctx.admin, body: { expectedRevision: ctx.dep1.revision, reason: "lab: revision 2" } });
  const c2 = await waitFor("revision 2 converged", async () => (await deploymentState(d2.revision)).find((s) => s.state === "converged"), { timeoutMs: 240_000, intervalMs: 2000 }).catch(() => null);
  const r2 = await call(`/${A.slug}/v2`, A.key);
  await api.ok("DELETE", `/api/v1/environments/${A.id}/routes/${extra.id}`, { session: ctx.admin });
  await api.ok("POST", `/api/v2/workspaces/${A.id}/releases`, { session: ctx.admin, body: { message: "lab: back to the first content" } });
  const d3 = await api.ok("POST", "/api/v2/deployments", { session: ctx.admin, body: { expectedRevision: d2.revision, reason: "lab: revision 3 = content of 1" } });
  const c3 = await waitFor("revision 3 converged", async () => (await deploymentState(d3.revision)).find((s) => s.state === "converged"), { timeoutMs: 240_000, intervalMs: 2000 }).catch(() => null);
  const r3 = await call(`/${A.slug}/v2`, A.key);
  const rows = await sql("select revision, config_hash, kong_config_hash, members from deployments order by revision");
  const memberOf = (row, wsId) => (row.members ?? []).find((m) => m.workspaceId === wsId);
  const nodes = await nodesOf();
  Object.assign(it.measures, { revisions: rows.map((r) => ({ revision: r.revision, configHash: r.config_hash, kongConfigHash: r.kong_config_hash })), r2Status: r2.s, r3Status: r3.s,
    converged2: Boolean(c2), converged3: Boolean(c3), nodes: nodes.map((n) => ({ node: n.node_id, evidence: n.evidence, verifiedRevision: n.verified_revision })),
    bDigest: rows.map((r) => memberOf(r, ctx.ws.B.id)?.contentDigest ?? null) });
  expect(it, c2 && c3, "a revision did not converge");
  expect(it, r2.s === 200 && r3.s !== 200, `route r2: rev2 ${r2.s}, rev3 ${r3.s}`);
  const h = Object.fromEntries(rows.map((r) => [r.revision, r.config_hash]));
  expect(it, h[d3.revision] === h[ctx.dep1.revision] && h[d2.revision] !== h[ctx.dep1.revision], `hashes ${JSON.stringify(h)}`);
  expect(it, new Set(it.measures.bDigest).size === 1, `B's member digest changed: ${JSON.stringify(it.measures.bDigest)}`);
  expect(it, nodes.filter((n) => n.evidence === "verified" && n.verified_revision === d3.revision).length >= 2, "nodes not verified on revision 3");
  ctx.dep1 = d3;
  done(it);
}

/** Aceite p (drain) + restart: deleting a serving pod; signal ≤ 1 s (Ks), Kong out ≤ 20 s, kong before the sidecars;
 * the replacement is admitted (F3 path) and the deployment converges; the stale node's effect is recorded. */
async function drainAndReplace() {
  const it = item("V2-p-drain", "Serving pod deleted with traffic and an open WebSocket: supervisor signal (Ks), nginx exit (Kx after SIGKILL if the drain runs out), kong exits before the sidecars; replacement admitted and converged; stale node of the deleted pod measured", V2_BUDGET);
  const client = new Client("drain", [ctx.proxy.host, String(ctx.proxy.port), `/${ctx.ws.A.slug}/api`, ctx.ws.A.key, `/${ctx.ws.A.slug}/api/ws`]);
  await sleep(5000);
  const [p] = await live();
  const pj = await json(["-n", NS.dp, "get", "pod", p.name]);
  const ids = Object.fromEntries([...pj.status.initContainerStatuses, ...pj.status.containerStatuses].filter((c) => c.containerID && c.state?.running).map((c) => [c.name, c.containerID.replace(/^containerd:\/\//, "")]));
  const follow = new Follower(p.name, "kong");
  followers.push(follow);
  const known = new Set((await pods()).map((x) => x.uid));
  const loadStart = await vmLoad("drain start");
  const exits = watchExits(pj.spec.nodeName, ids, 60);
  const t0 = await vmNow();
  await kubectl(["-n", NS.dp, "delete", "pod", p.name, "--wait=false"]);
  const t0b = await vmNow();
  const ex = await exits;
  const loadEnd = await vmLoad("drain end");
  const lines = (await vmLogs(p.name, "kong").catch(() => [])).concat(follow.lines.map((l) => ({ at: l.at + skew, text: l.text })));
  const sig = first(lines, (l) => l.at >= t0 && /stop signal: draining/.test(l.text));
  const kill = first(lines, (l) => l.at >= t0 && /drain exceeded/.test(l.text));
  const exited = first(lines, (l) => l.at >= t0 && /nginx \(pid \d+\) exited/.test(l.text));
  const fin = Object.fromEntries(Object.entries(ex.states).map(([k, v]) => [k, v.finishedAtNode ? vmTime(v.finishedAtNode) - t0 : null]));
  const replacement = await newPod(known);
  const g = await waitFor("replacement granted", () => grantedOf(ctx.clusterId, replacement.uid), { timeoutMs: 120_000 }).catch(() => null);
  const ready = await waitFor("replacement Ready", async () => podReady((await json(["-n", NS.dp, "get", "pod", replacement.name])).status), { timeoutMs: 180_000, intervalMs: 1000 }).catch(() => false);
  await sleep(10_000);
  await client.stop();
  const nodes = await nodesOf();
  const ws = client.since(t0).filter((e) => e.k === "ws");
  Object.assign(it.measures, { vmLoad: { start: loadStart, end: loadEnd }, deleteCallMs: t0b - t0, KsUpperMs: rel(sig?.at, t0), sigkillMs: rel(kill?.at, t0), nginxExitedMs: rel(exited?.at, t0),
    Kx: kill && exited ? exited.at - kill.at : null, containersFinishedMs: fin, kongBeforeSidecars: fin.kong != null && ["agent", "isolation-probe", "collector"].every((c) => fin[c] == null || fin[c] >= fin.kong),
    wsEvents: ws.map((e) => `${e.ev}@${e.t - t0}`).slice(0, 6), replacementGranted: Boolean(g), replacementReady: Boolean(ready),
    nodesAfter: nodes.map((n) => ({ node: n.node_id, evidence: n.evidence })), deploymentStates: (await deploymentState(ctx.dep1.revision)).map((s) => s.state).slice(-4) });
  expect(it, sig && sig.at - t0 <= 1000 + (t0b - t0), `supervisor signal at ${it.measures.KsUpperMs} ms (Ks upper bound from the delete call)`);
  expect(it, fin.kong != null && fin.kong <= V2_BUDGET.drainExit, `kong finished ${fin.kong} ms`);
  expect(it, it.measures.kongBeforeSidecars, `exit order ${JSON.stringify(fin)}`);
  expect(it, g && ready, "replacement not admitted/Ready");
  const stale = nodes.find((n) => n.node_id === p.name);
  if (stale) it.notes.push(`known gap: the deleted pod's node stays registered (evidence ${stale.evidence}); deployment states ${JSON.stringify(it.measures.deploymentStates)}`);
  if (stale) { await sql(`with d as (delete from cluster_nodes where cluster_id = '${ctx.clusterId}' and node_id = '${p.name}' returning 1) select count(*)::int as n from d`); it.notes.push("lab contour: stale cluster_nodes row removed"); }
  if (loadEnd > 16) it.notes.push(`VM load ${loadEnd} > 16: repeat`);
  done(it);
}

function secretScanV2() {
  const secrets = [ctx.registrationToken, ctx.secrets?.pgPassword, ctx.secrets?.admin.password, ctx.secrets?.editor.password, ctx.secrets?.env.GROMESH_ENCRYPTION_KEY,
    ctx.secrets?.env.GROMESH_FINGERPRINT_KEY, ctx.admin?.cookie, ctx.admin?.csrf, ctx.editor?.cookie, ctx.editor?.csrf, ctx.chWriter, ...secretsSeen].filter(Boolean);
  const leaks = [];
  const files = readdirSync(out);
  for (const file of files) { const text = readFileSync(join(out, file), "utf8"); secrets.forEach((s, i) => { if (text.includes(s)) leaks.push({ file, secret: i }); }); }
  return { files, secrets: secrets.length, leaks };
}
let finishedV2 = false;
async function finishV2() {
  if (finishedV2) return;
  finishedV2 = true;
  report.thawed = await thawAll();
  for (const f of followers) f.stop();
  for (const c of clients) await c.stop().catch(() => {});
  ctx.forward?.stop();
  if (process.env.LAB_KEEP === "1") report.cleanup = "kept (LAB_KEEP=1)";
  else if (ctx.owned) {
    await docker(["exec", "gromesh-n2-lab-fx-backend", "pkill", "-f", `listen\\(${BACKEND_PORT}`], { allowFail: true });
    await Promise.all([removeSuiteObjects(), kubectl(["delete", "namespace", OBS, "--ignore-not-found", "--wait", "--timeout=240s"], { timeout: 260_000 })])
      .then(() => { report.cleanup = "namespaces, policies and the backend server removed"; }, (e) => { report.cleanup = `failed: ${e.message}`; report.cleanupFailed = true; });
  }
  if (frozen.size) { report.cleanupFailed = true; report.stillFrozen = [...frozen]; }
  report.finishedAt = new Date().toISOString();
  save();
  report.secretScan = secretScanV2();
  save();
  log(`cleanup: ${report.cleanup}; secret scan: ${report.secretScan.leaks.length} leaks`);
}
const clients = [];
{ const C = Client; Client = class extends C { constructor(...a) { super(...a); clients.push(this); } }; }

async function mainV2() {
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { report.aborted = { signal }; finishV2().finally(() => process.exit(130)); });
  const all = [setupV2, d4Disabled, convergeV2, trafficV2, hashDivergence, revisionMismatch, rollbackV2, agentDown, probeDown, drainAndReplace, containmentN, function containmentFrozen() { return containmentN({ frozenSupervisor: true }); }];
  const only = (process.env.LAB_STEPS ?? "").split(",").filter(Boolean);
  const chosen = only.length ? all.filter((s, i) => i < 4 || only.includes(s.name)) : all;
  report.steps = chosen.map((s) => s.name);
  try {
    for (const step of chosen) {
      try { await step(); } catch (error) {
        log(`step ${step.name} aborted: ${error.stack ?? error}`);
        for (const it of report.items.filter((i) => i.result === "pending")) { it.failures.push(`aborted: ${error.message}`); it.result = "fail"; }
        if (step === setupV2 || step === d4Disabled || step === convergeV2) { report.aborted = { step: step.name, error: String(error.message ?? error) }; break; }
      }
    }
  } finally { await finishV2(); }
  console.log(`results: ${join(out, "results.json")}`);
  // A failed, pending or aborted item, a leaked secret or a failed cleanup fails the run (the runner reads the code).
  const failed = report.items.filter((i) => i.result === "fail" || i.result === "pending");
  if (failed.length || report.aborted || report.secretScan?.leaks?.length || report.cleanupFailed) process.exit(1);
}
await mainV2();
