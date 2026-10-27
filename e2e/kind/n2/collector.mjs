#!/usr/bin/env node
// N2-X4 in the reference lab (B §3.5.2, aceite r, exposure part): the data plane chart in Workspaces mode with the
// collector as a native sidecar, Cilium enforcing the chart's NetworkPolicy, ClickHouse in the cluster.
//   LAB_KUBECONFIG=<file> AGENT_IMAGE=<local tag> KONG_IMAGE=<local tag> [LAB_OUT=<dir>] node e2e/kind/n2/collector.mjs
// Requires the cluster from cluster.sh. No control plane: Kong never gets a lease here, the sidecars run regardless.
// Never prints the collector token or the ClickHouse passwords.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { assertLabKubeconfig } from "./checks.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const versions = Object.fromEntries(readFileSync(join(here, "versions.env"), "utf8").split("\n")
  .filter((line) => /^[A-Z0-9_]+=/.test(line)).map((line) => line.split(/=(.*)/s).slice(0, 2)));
const kubeconfig = process.env.LAB_KUBECONFIG;
assertLabKubeconfig(kubeconfig, homedir());
const context = `kind-${versions.CLUSTER_NAME}`;
const work = mkdtempSync(join(tmpdir(), "gromesh-x4-kind-"));
const out = process.env.LAB_OUT ?? work;
const AGENT_IMAGE = process.env.AGENT_IMAGE;
const KONG_IMAGE = process.env.KONG_IMAGE;
const CLICKHOUSE_IMAGE = "clickhouse/clickhouse-server:25.8.33.6-alpine";
const VECTOR_IMAGE = "timberio/vector:0.57.0-alpine";
assert.ok(AGENT_IMAGE && KONG_IMAGE, "set AGENT_IMAGE and KONG_IMAGE to local tags loaded into the lab");
const DP = "gromesh-x4";
const OBS = "gromesh-x4-obs";
const FX = "gromesh-x4-fx";
const env = { ...process.env, KUBECONFIG: kubeconfig };
const secrets = [];
const results = [];
const record = (item, ok, detail) => {
  results.push({ item, ok, detail });
  assert.ok(ok, `${item}: ${detail}`);
};

function run(command, args, { input, timeout = 180_000, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || allowFail) resolve({ code, stdout, stderr });
      else reject(new Error(`${command} ${args.slice(0, 6).join(" ")} exited ${code}: ${(stderr || stdout).slice(0, 400)}`));
    });
    child.stdin.end(input ?? "");
  });
}
const kubectl = (args, options) => run("kubectl", ["--kubeconfig", kubeconfig, "--context", context, ...args], options);
const helm = (args, options) => run("helm", ["--kubeconfig", kubeconfig, "--kube-context", context, ...args], options);
const apply = (objects) => kubectl(["apply", "-f", "-"], { input: JSON.stringify({ apiVersion: "v1", kind: "List", items: objects }) });
const json = async (args) => JSON.parse((await kubectl([...args, "-o", "json"])).stdout);

async function until(label, fn, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await sleep(2000);
  }
}

const clusterId = randomUUID();
const instanceId = randomUUID();
const chAdmin = randomBytes(16).toString("hex");
const chWriter = randomBytes(16).toString("hex");
secrets.push(chAdmin, chWriter);

async function clickhouse() {
  await apply([{ apiVersion: "v1", kind: "Namespace", metadata: { name: OBS } },
    { apiVersion: "v1", kind: "Secret", metadata: { name: "ch", namespace: OBS }, stringData: { admin: chAdmin } },
    { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "schema", namespace: OBS }, data: {
      "001-requests.sql": readFileSync(join(root, "deploy/observability/clickhouse/001-requests.sql"), "utf8"),
      "002-retention.sql": readFileSync(join(root, "deploy/observability/clickhouse/002-retention.sql"), "utf8") } },
    { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "clickhouse", namespace: OBS }, spec: { replicas: 1,
      selector: { matchLabels: { app: "clickhouse" } }, template: { metadata: { labels: { app: "clickhouse" } }, spec: { containers: [{
        name: "clickhouse", image: CLICKHOUSE_IMAGE, imagePullPolicy: "IfNotPresent",
        env: [{ name: "CLICKHOUSE_DB", value: "gromesh" }, { name: "CLICKHOUSE_USER", value: "admin" },
          { name: "CLICKHOUSE_PASSWORD", valueFrom: { secretKeyRef: { name: "ch", key: "admin" } } },
          { name: "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT", value: "1" }],
        ports: [{ containerPort: 8123 }], volumeMounts: [{ name: "schema", mountPath: "/docker-entrypoint-initdb.d" }] }],
      volumes: [{ name: "schema", configMap: { name: "schema" } }] } } } },
    { apiVersion: "v1", kind: "Service", metadata: { name: "clickhouse", namespace: OBS }, spec: { selector: { app: "clickhouse" }, ports: [{ port: 8123 }] } }]);
  await until("clickhouse schema", async () => (await chq("SELECT count() FROM gromesh.requests")) !== undefined, 300_000);
  await chq(`CREATE USER IF NOT EXISTS gromesh_writer IDENTIFIED WITH sha256_password BY '${chWriter}'`);
  await chq("GRANT INSERT ON gromesh.requests TO gromesh_writer");
}
async function chq(sql) {
  const { stdout } = await kubectl(["exec", "-n", OBS, "deploy/clickhouse", "--", "clickhouse-client", "-u", "admin", "--password", chAdmin, "-q", sql], { timeout: 60_000 });
  return stdout.trim();
}
const rows = async () => Number(await chq(`SELECT count() FROM gromesh.requests WHERE environment_id = '${instanceId}'`));

function values({ clickhousePeers }) {
  return {
    agent: { token: "lab-placeholder-registration-token", controlPlaneUrl: "http://control-plane.invalid:3000",
      image: { repository: AGENT_IMAGE.split(":")[0], tag: AGENT_IMAGE.split(":")[1], digest: "", pullPolicy: "Never" } },
    kong: { image: { repository: KONG_IMAGE.split(":")[0], tag: KONG_IMAGE.split(":")[1], digest: "", pullPolicy: "Never" } },
    workspaces: { enabled: true, clusterId,
      instanceSigningKeys: [{ kid: "LduU6YNgsIRbClfLYYXfg5VEWL3S5q8TsrvV01NRaic", publicKey: "vIeB87e8hCwQ5rBCgRDOAdhiVQhLPBJSuNoepr249V4" }],
      probe: { checks: [
        { capability: "CAP-1", kind: "tcp", name: "outside", address: "outside.invalid:8080" },
        { capability: "CAP-2", kind: "tcp", name: "node", address: "10.0.0.1:10250" },
        { capability: "CAP-3", kind: "tcp", name: "imds", address: "169.254.169.254:80" },
        { capability: "CAP-4", kind: "tcp", name: "rebind", address: "rebind.invalid:80" },
        { capability: "CAP-4", kind: "dns", name: "dns", host: "kubernetes.default.svc" },
        { capability: "CAP-1", kind: "tcp-open", name: "dns tcp", address: "kube-dns.kube-system.svc:53" },
        { capability: "CAP-5", kind: "tcp", name: "validator", address: "validator.invalid:8001" },
        { capability: "CAP-6", kind: "http", name: "agent metrics", url: "http://127.0.0.1:9100/metrics", expectStatus: 403 },
        { capability: "CAP-7", kind: "http", name: "collector token", url: "http://127.0.0.1:8080/kong", expectStatus: 401, method: "POST" },
      ] } },
    collector: { enabled: true, mode: "sidecar", clusterId, environmentId: instanceId,
      image: { repository: "timberio/vector", tag: "0.57.0-alpine", digest: "", pullPolicy: "IfNotPresent" },
      clickhouse: { endpoint: `http://clickhouse.${OBS}.svc.cluster.local:8123`, existingSecret: "clickhouse-writer" } },
    networkPolicy: { enabled: true,
      controlPlanePeers: [{ ipBlock: { cidr: "192.0.2.0/24" } }],
      clickhousePeers },
  };
}
const allowed = [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": OBS } }, podSelector: { matchLabels: { app: "clickhouse" } } }];
const nobody = [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": OBS } }, podSelector: { matchLabels: { app: "nothing-here" } } }];

async function install(v) {
  writeFileSync(join(work, "values.json"), JSON.stringify(v));
  await helm(["upgrade", "--install", "dp", join(root, "deploy/helm/data-plane"), "-n", DP, "-f", join(work, "values.json")], { timeout: 300_000 });
}
async function pod() {
  return until("data plane pod with a running collector", async () => {
    const list = await json(["get", "pods", "-n", DP, "-l", "app.kubernetes.io/name=data-plane"]);
    const live = list.items.filter((p) => !p.metadata.deletionTimestamp);
    const p = live.length === 1 ? live[0] : undefined;
    const c = p?.status.initContainerStatuses?.find((s) => s.name === "collector");
    return c?.state?.running && c.started ? p : undefined;
  }, 300_000);
}
const inCollector = (p, sh) => kubectl(["exec", "-n", DP, p.metadata.name, "-c", "collector", "--", "sh", "-c", sh], { allowFail: true, timeout: 60_000 });
// Status of a POST from inside the pod; the header value comes from the collector's own environment when asked.
async function postInPod(p, { tokenFrom = "", body }) {
  const header = tokenFrom ? `--header "X-Gromesh-Collector-Token: $${tokenFrom}"` : "";
  const r = await inCollector(p, `wget -q -S -O /dev/null ${header} --post-data '${body}' http://127.0.0.1:8080/kong 2>&1 | sed -n 's/^ *HTTP\\/1.1 \\([0-9]*\\).*/\\1/p' | head -1`);
  return r.stdout.trim();
}
const event = (rid) => JSON.stringify([{ environment_id: instanceId, started_at: Date.now(), client_ip: "10.0.0.9",
  request: { id: rid, uri: "/lab", method: "GET", size: 1 }, response: { status: 200, size: 1 }, latencies: { kong: 1, proxy: 1, request: 2 } }]);

async function fromOutside(ip) {
  await apply([{ apiVersion: "v1", kind: "Namespace", metadata: { name: FX } }]);
  const name = `outsider-${randomBytes(3).toString("hex")}`;
  await kubectl(["run", name, "-n", FX, "--image", versions.FIXTURE_IMAGE, "--restart=Never", "--command", "--", "node", "-e", `
    const { connect } = require('node:net');
    const tryPort = (port) => new Promise((r) => { const s = connect({ host: '${ip}', port, timeout: 3000 });
      s.on('connect', () => { s.destroy(); r('open'); }); s.on('error', (e) => r(e.code)); s.on('timeout', () => { s.destroy(); r('timeout'); }); });
    (async () => console.log(JSON.stringify({ intake: await tryPort(8080), metrics: await tryPort(9598) })))();`]);
  const phase = await until("outsider pod", async () => { const p = await json(["get", "pod", "-n", FX, name]); return ["Succeeded", "Failed"].includes(p.status.phase) && p.status.phase; });
  const { stdout } = await kubectl(["logs", "-n", FX, name]);
  await kubectl(["delete", "pod", "-n", FX, name, "--wait=false"]);
  return phase === "Succeeded" ? JSON.parse(stdout.trim()) : { error: stdout };
}
async function fromNode(ip) {
  const node = `${versions.CLUSTER_NAME}-worker`;
  const r = await run("docker", ["exec", node, "bash", "-c", `for p in 8080 9598; do (exec 3<>/dev/tcp/${ip}/$p) 2>/dev/null && echo "$p open" || echo "$p refused"; done`], { allowFail: true });
  return r.stdout.trim().replaceAll("\n", ", ");
}

async function main() {
  const status = await run("bash", [join(here, "cluster.sh"), "status"], { allowFail: true, env: { LAB_KUBECONFIG: kubeconfig } });
  assert.equal(status.code, 0, `the lab is not the pinned kind cluster: ${status.stderr.trim()}`);
  await clickhouse();
  await apply([{ apiVersion: "v1", kind: "Namespace", metadata: { name: DP } },
    { apiVersion: "v1", kind: "Secret", metadata: { name: "clickhouse-writer", namespace: DP }, stringData: { "writer-password": chWriter } }]);
  await install(values({ clickhousePeers: allowed }));
  let p = await pod();
  const spec = p.spec;
  const containers = [...spec.initContainers, ...spec.containers];
  const holders = (name) => containers.filter((c) => (c.env ?? []).some((e) => e.name === name)).map((c) => c.name).sort().join(",");
  record("native sidecar order", spec.initContainers.map((c) => `${c.name}:${c.restartPolicy ?? "-"}`).join(" ") === "seed-config:- isolation-install:- agent:Always isolation-probe:Always collector:Always",
    spec.initContainers.map((c) => c.name).join(" "));
  record("credentials by container", holders("GROMESH_COLLECTOR_TOKEN") === "collector,kong" && holders("CLICKHOUSE_PASSWORD") === "collector",
    `token: ${holders("GROMESH_COLLECTOR_TOKEN")}; writer password: ${holders("CLICKHOUSE_PASSWORD")}`);
  const services = (await json(["get", "svc", "-n", DP])).items.map((s) => s.metadata.name);
  record("no collector Service", !services.includes("gromesh-collector"), services.join(","));

  const listen = (await inCollector(p, "netstat -tln | awk '$6 == \"LISTEN\" {print $4}' | grep -E ':(8080|9598)$' | sort")).stdout.trim().split("\n");
  record("collector listens only on loopback", listen.join(" ") === "127.0.0.1:8080 127.0.0.1:9598", listen.join(" "));
  const probeConfig = await kubectl(["exec", "-n", DP, p.metadata.name, "-c", "isolation-probe", "--", "/gromesh/isolation-bin/isolation-probe", "check-config", "/etc/gromesh/probe.json"], { allowFail: true });
  record("probe accepts the POST CAP-7 check", probeConfig.stdout.trim() === "probe config ok", (probeConfig.stdout + probeConfig.stderr).trim());

  const ip = p.status.podIP;
  record("other pod cannot connect", JSON.stringify(await fromOutside(ip)) === JSON.stringify({ intake: "ECONNREFUSED", metrics: "ECONNREFUSED" }), "intake and metrics refused at the pod IP");
  const node = await fromNode(ip);
  record("node cannot connect", node === "8080 refused, 9598 refused", node);

  record("no token -> 401", (await postInPod(p, { body: event(randomBytes(16).toString("hex")) })) === "401", "POST from inside the pod");
  const before = await rows();
  const rid = randomBytes(16).toString("hex");
  const first = await postInPod(p, { tokenFrom: "GROMESH_COLLECTOR_TOKEN", body: event(rid) });
  const second = await postInPod(p, { tokenFrom: "GROMESH_COLLECTOR_TOKEN", body: event(rid) });
  await until("event in ClickHouse", async () => (await rows()) === before + 1, 120_000);
  await sleep(5000);
  record("event reaches ClickHouse through the policy, repeated once", first === "200" && second === "200" && (await rows()) === before + 1, `${await rows() - before} row for 2 identical batches`);

  // Negative control 1: without the ClickHouse egress rule (peers that select nothing) Cilium drops the writes.
  await install(values({ clickhousePeers: nobody }));
  await sleep(5000);
  p = await pod();
  const blockedBefore = await rows();
  record("control: accepted without egress", (await postInPod(p, { tokenFrom: "GROMESH_COLLECTOR_TOKEN", body: event(randomBytes(16).toString("hex")) })) === "200", "intake still answers");
  await sleep(20_000);
  record("control: no row without the egress rule", (await rows()) === blockedBefore, "the policy is load-bearing");

  // Negative control 2: the same sidecar bound to 0.0.0.0 is reachable from another pod (the exposure test catches it).
  await install(values({ clickhousePeers: allowed }));
  await kubectl(["set", "env", "-n", DP, "deployment/dp-data-plane", "-c", "collector", "GROMESH_COLLECTOR_ADDRESS=0.0.0.0:8080"]);
  await sleep(5000);
  p = await until("pod bound to 0.0.0.0", async () => {
    const q = await pod();
    return q.spec.initContainers.find((c) => c.name === "collector").env.find((e) => e.name === "GROMESH_COLLECTOR_ADDRESS").value === "0.0.0.0:8080" ? q : undefined;
  });
  const exposed = await fromOutside(p.status.podIP);
  record("control: 0.0.0.0 reachable from another pod", exposed.intake === "open", JSON.stringify(exposed));
  const logs = (await kubectl(["logs", "-n", DP, p.metadata.name, "-c", "collector"], { allowFail: true })).stdout;
  record("no secret in collector logs", secrets.every((s) => !logs.includes(s)), "writer and admin passwords absent");
}

try {
  await main();
} finally {
  const text = JSON.stringify({ kubernetes: versions.KUBERNETES_VERSION, cilium: versions.CILIUM_VERSION, agentImage: AGENT_IMAGE, kongImage: KONG_IMAGE, vectorImage: VECTOR_IMAGE, results }, null, 2);
  assert.ok(secrets.every((s) => !text.includes(s)), "evidence must not carry a secret");
  writeFileSync(join(out, "X4-kind-results.json"), text);
  console.log(`N2-X4 kind: ${results.filter((r) => r.ok).length}/${results.length} checks passed (${join(out, "X4-kind-results.json")})`);
}
