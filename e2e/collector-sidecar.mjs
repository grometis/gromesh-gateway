#!/usr/bin/env node
// N2-X4 (B §3.5.2, aceite r): the analytics collector as a sidecar of the Kong pod, with real Kong, Vector and
// ClickHouse in Docker. A "pod" is one network namespace shared by kong and collector; nothing else joins it.
//   [X4_OUT=<dir>] node e2e/collector-sidecar.mjs
// Never prints a token, a password or a raw event.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CLICKHOUSE_IMAGE, NODE_IMAGE, pullImages, VECTOR_IMAGE } from "./docker-images.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const KONG_IMAGE = process.env.KONG_IMAGE ?? "ghcr.io/grometis/gromesh-kong@sha256:ffe28812ade7f8aaec8ff1303b5c5f2e614453b87e1b3bd917401f6ad8b74faf";
const GO_IMAGE = "golang:1.27.2-alpine";
const id = randomBytes(4).toString("hex");
const net = `gromesh-x4-${id}`;
const names = { ch: `x4-ch-${id}`, pod: `x4-pod-${id}`, collector: `x4-collector-${id}`, kong: `x4-kong-${id}`, outsider: `x4-outsider-${id}` };
const work = mkdtempSync(join(tmpdir(), "gromesh-x4-"));
chmodSync(work, 0o755);
const out = process.env.X4_OUT ?? work;
const results = [];
const secrets = [];
// A failed execFile carries its command line and output: redact every credential before it can reach a terminal.
const redact = (text) => secrets.reduce((t, secret) => t.replaceAll(secret, "REDACTED"), String(text ?? ""));
const docker = (args, timeout = 120_000) => exec("docker", args, { cwd: root, timeout, maxBuffer: 16 * 1024 * 1024 }).catch((e) => {
  throw Object.assign(new Error(redact(`docker ${args[0]} failed: ${e.stderr || e.message}`)), { stdout: redact(e.stdout), stderr: redact(e.stderr) });
});
const record = (item, ok, detail) => {
  results.push({ item, ok, detail });
  assert.ok(ok, `${item}: ${detail}`);
};

const clusterId = randomUUID();
const otherClusterId = randomUUID();
const instanceId = randomUUID();
const podUid = randomUUID();
const token = randomBytes(24).toString("hex");
const nextToken = randomBytes(24).toString("hex");
const otherClusterToken = randomBytes(24).toString("hex");
const chAdmin = randomBytes(16).toString("hex");
const chWriter = randomBytes(16).toString("hex");
secrets.push(token, nextToken, otherClusterToken, chAdmin, chWriter);

// Runs a Node snippet inside the pod's network namespace (or outside it, on the same Docker network). X4_SEND_TOKEN
// reaches it through the environment (docker run -e NAME copies this process's value): never an argument.
async function inPod(script, args = [], { outside = false } = {}) {
  const network = outside ? ["--network", net] : ["--network", `container:${names.pod}`];
  const { stdout } = await docker(["run", "--rm", ...network, "-e", "X4_SEND_TOKEN", NODE_IMAGE, "node", "--input-type=module", "-e", script, ...args], 240_000);
  return JSON.parse(stdout.trim().split("\n").at(-1));
}
// Vector answers 401 before reading the body and may close the socket under the sender: a refused POST can surface as
// a socket error instead of its status, so a socket error is retried (the status is what is asserted).
// sendToken: the collector token header value, or "" for none.
const post = (url, sendToken, body) => (process.env.X4_SEND_TOKEN = sendToken, inPod(`
  const headers = process.env.X4_SEND_TOKEN ? { 'x-gromesh-collector-token': process.env.X4_SEND_TOKEN } : {};
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(process.argv[1], { method: 'POST', headers, body: process.argv[2], signal: AbortSignal.timeout(5000) });
      await r.arrayBuffer();
      last = { status: r.status };
      break;
    } catch (e) { last = { error: e.cause?.code ?? e.name }; }
  }
  console.log(JSON.stringify(last));`, [url, body]));

// The admin password is the ClickHouse container's own CLICKHOUSE_PASSWORD: never an argument.
async function query(sql) {
  const { stdout } = await docker(["exec", names.ch, "sh", "-c", 'clickhouse-client -u admin --password "$CLICKHOUSE_PASSWORD" -q "$1"', "sh", sql]);
  return stdout.trim();
}
const rows = async (instance = instanceId) => Number(await query(`SELECT count() FROM gromesh.requests WHERE environment_id = '${instance}'`));
async function rowsSettle(expected, label) {
  for (let i = 0; i < 60; i++) {
    const n = await rows();
    if (n === expected) {
      await sleep(3000);
      if ((await rows()) === expected) return expected;
    }
    await sleep(500);
  }
  return rows().then((n) => record(label, false, `${n} rows, expected ${expected}`));
}

function event(requestId, instance = instanceId) {
  return JSON.stringify([{ environment_id: instance, started_at: Date.now(), client_ip: "10.0.0.9",
    request: { id: requestId, uri: "/forged", method: "GET", size: 1 }, response: { status: 200, size: 1 },
    latencies: { kong: 1, proxy: 1, request: 2 } }]);
}

async function startCollector({ config = join(root, "deploy/observability/vector"), address = "127.0.0.1:8080" } = {}) {
  await docker(["rm", "-f", names.collector]).catch(() => {});
  await docker(["run", "-d", "--name", names.collector, "--network", `container:${names.pod}`, "--user", "65534:65534",
    "--read-only", "--tmpfs", "/var/lib/vector:uid=65534",
    "-e", `GROMESH_COLLECTOR_ADDRESS=${address}`, "-e", "GROMESH_COLLECTOR_METRICS_ADDRESS=127.0.0.1:9598",
    "-e", `GROMESH_POD_UID=${podUid}`, "-e", `GROMESH_CLUSTER_ID=${clusterId}`, "-e", `GROMESH_ENVIRONMENT_ID=${instanceId}`,
    "-e", "GROMESH_COLLECTOR_TOKEN", "-e", "GROMESH_COLLECTOR_TOKEN_PREVIOUS", "-e", "CLICKHOUSE_PASSWORD",
    "-e", `CLICKHOUSE_ENDPOINT=http://${names.ch}:8123`, "-e", "CLICKHOUSE_DATABASE=gromesh", "-e", "VECTOR_LOG=info",
    "-v", `${config}:/etc/vector:ro`, "--entrypoint", "sh", VECTOR_IMAGE, "/etc/vector/entrypoint.sh"], 60_000)
    .catch((e) => { throw new Error(`collector start failed: ${e.message.split("\n")[0]}`); });
  for (let i = 0; i < 40; i++) {
    const r = await post("http://127.0.0.1:8080/kong", "", "[]");
    if (r.status) return;
    await sleep(500);
  }
  throw new Error("collector did not listen");
}
// docker run reads -e NAME without a value from this process: the secrets never appear in its argument list.
const setTokens = (current, previous = "") => {
  process.env.GROMESH_COLLECTOR_TOKEN = current;
  process.env.GROMESH_COLLECTOR_TOKEN_PREVIOUS = previous;
};

async function probe(url, expect) {
  // The probe's own CAP-7 check (apps/isolation), compiled and run inside the pod's network namespace.
  const { stdout, stderr } = await docker(["run", "--rm", "--network", `container:${names.pod}`, "-v", `${root}apps/isolation:/src:ro`,
    "-w", "/src", "-e", "GOTOOLCHAIN=local", "-e", "GOCACHE=/tmp/go-cache", "-e", `GROMESH_REAL_COLLECTOR_URL=${url}`,
    "-e", `GROMESH_REAL_COLLECTOR_EXPECT=${expect}`, GO_IMAGE, "go", "test", "./internal/probe/", "-run", "TestRealSidecarCollector", "-count=1", "-v"], 300_000)
    .catch((e) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? e.message }));
  return /--- PASS: TestRealSidecarCollector/.test(stdout) ? "ok" : `failed: ${(stdout + stderr).split("\n").filter((l) => /want|FAIL/.test(l)).join(" | ")}`;
}

async function main() {
  await pullImages([VECTOR_IMAGE, NODE_IMAGE, CLICKHOUSE_IMAGE, KONG_IMAGE, GO_IMAGE]);
  await docker(["network", "create", net]);
  process.env.CLICKHOUSE_PASSWORD = chAdmin;
  // ClickHouse with the repository's schema and the INSERT-only writer the collector uses.
  await docker(["run", "-d", "--name", names.ch, "--network", net, "-e", "CLICKHOUSE_DB=gromesh", "-e", "CLICKHOUSE_USER=admin",
    "-e", "CLICKHOUSE_PASSWORD", "-e", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1",
    "-v", `${root}deploy/observability/clickhouse:/docker-entrypoint-initdb.d:ro`, CLICKHOUSE_IMAGE], 120_000);
  for (let i = 0; ; i++) {
    if (await query("SELECT count() FROM gromesh.requests").then(() => true, () => false)) break;
    assert.ok(i < 120, "ClickHouse did not come up");
    await sleep(1000);
  }
  process.env.X4_CH_WRITER = chWriter;
  // The image restarts the server after its init scripts: the first answer may come from the temporary one.
  for (let i = 0, ok = 0; ; i++) {
    const created = await docker(["exec", "-e", "X4_CH_WRITER", names.ch, "sh", "-c", `clickhouse-client -u admin --password "$CLICKHOUSE_PASSWORD" -n -q "CREATE USER IF NOT EXISTS gromesh_writer IDENTIFIED WITH sha256_password BY '$X4_CH_WRITER'; GRANT INSERT ON gromesh.requests TO gromesh_writer;"`])
      .then(() => true, () => false);
    ok = created ? ok + 1 : 0;
    if (ok >= 3) break;
    assert.ok(i < 120, "ClickHouse writer could not be created");
    await sleep(1000);
  }
  process.env.CLICKHOUSE_PASSWORD = chWriter;

  // The pod: a network namespace holder, the collector sidecar and Kong.
  await docker(["run", "-d", "--name", names.pod, "--network", net, NODE_IMAGE, "sleep", "infinity"]);
  setTokens(token);
  await startCollector();

  await exec("pnpm", ["--filter", "@gromesh/compiler", "build"], { cwd: root, timeout: 120_000 });
  const { compile, platformPlugins } = await import("../packages/compiler/dist/index.js");
  const serviceId = randomUUID();
  const forcedId = randomUUID();
  const routeId = randomUUID();
  const config = compile({
    services: [
      { id: serviceId, name: "terminated", protocol: "http", host: "127.0.0.1", port: 9 },
      // Config forced straight into Kong (the control plane refuses loopback targets): the proxy towards the collector.
      { id: forcedId, name: "to-collector", protocol: "http", host: "127.0.0.1", port: 8080, path: "/kong" },
    ],
    routes: [
      { id: routeId, name: "traffic", serviceId, paths: ["/traffic"] },
      { id: randomUUID(), name: "forced", serviceId: forcedId, paths: ["/forced"], methods: ["POST"] },
    ],
    consumers: [], keyAuthCredentials: [],
    plugins: [{ id: randomUUID(), name: "request-termination", scope: { routeId }, config: { status_code: 200, message: "ok" } }],
  }, { platformPlugins: platformPlugins({ environmentId: instanceId, httpLogEndpoint: "http://127.0.0.1:8080/kong" }) });
  writeFileSync(join(work, "kong.json"), JSON.stringify(config));
  // The chart's kong env for Workspaces mode with the collector: one KONG_NGINX_MAIN_ENV naming both variables.
  await docker(["run", "-d", "--name", names.kong, "--network", `container:${names.pod}`, "--user", "1001:1001",
    "--tmpfs", "/kong_prefix:uid=1001", "--tmpfs", "/tmp:uid=1001", "-v", `${work}/kong.json:/kong/declarative/kong.json:ro`,
    "-e", "KONG_DATABASE=off", "-e", "KONG_DECLARATIVE_CONFIG=/kong/declarative/kong.json", "-e", "KONG_PREFIX=/kong_prefix",
    "-e", "KONG_ADMIN_LISTEN=off", "-e", "KONG_STATUS_LISTEN=off", "-e", "KONG_ADMIN_GUI_LISTEN=off", "-e", "KONG_PROXY_LISTEN=0.0.0.0:8000",
    "-e", "KONG_NGINX_DAEMON=off", "-e", `GROMESH_POD_UID=${podUid}`, "-e", "GROMESH_COLLECTOR_TOKEN",
    "-e", "KONG_NGINX_MAIN_ENV=GROMESH_POD_UID; env GROMESH_COLLECTOR_TOKEN", KONG_IMAGE, "kong", "docker-start"], 60_000);

  // 1. Real Kong events reach ClickHouse through the loopback sidecar, with the row id derived from Kong's request id.
  let kongIds = [];
  for (let i = 0; i < 60 && kongIds.length < 5; i++) {
    const r = await inPod(`
      const ids = [];
      for (let i = 0; i < 5; i++) {
        try { const r = await fetch('http://127.0.0.1:8000/traffic', { signal: AbortSignal.timeout(3000) }); await r.arrayBuffer();
          if (r.status === 200) ids.push(r.headers.get('x-kong-request-id')); } catch {}
      }
      console.log(JSON.stringify(ids));`);
    kongIds = r;
    if (kongIds.length < 5) await sleep(1000);
  }
  record("kong traffic", kongIds.length === 5 && kongIds.every((v) => /^[0-9a-f]{32}$/.test(v ?? "")), `${kongIds.length} requests answered with a request id`);
  await rowsSettle(5, "events from real Kong");
  const stored = (await query(`SELECT id, cluster_id FROM gromesh.requests WHERE environment_id = '${instanceId}' FORMAT JSONEachRow`)).split("\n").map((l) => JSON.parse(l));
  const { createHash } = await import("node:crypto");
  const derived = (rid) => createHash("sha256").update(`${clusterId}|${podUid}|${rid}`).digest("hex").slice(0, 32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
  record("row identity", stored.every((r) => r.cluster_id === clusterId) && kongIds.every((rid) => stored.some((r) => r.id === derived(rid))),
    "5 rows, cluster fixed by the collector, id = H(cluster, pod, Kong request id)");

  // 2. Listeners: the collector only on 127.0.0.1 in the pod (8080 intake, 9598 metrics).
  const listeners = await inPod(`
    import { readFileSync } from 'node:fs';
    const rows = ['/proc/net/tcp', '/proc/net/tcp6'].flatMap((f) => readFileSync(f, 'utf8').trim().split('\\n').slice(1));
    const listen = rows.map((r) => r.trim().split(/\\s+/)).filter((c) => c[3] === '0A').map((c) => c[1]);
    console.log(JSON.stringify(listen.filter((a) => ['1F90', '257E'].includes(a.split(':')[1]))));`);
  record("collector listeners", listeners.length === 2 && listeners.every((a) => a.startsWith("0100007F:")), JSON.stringify(listeners));

  // 3. From outside the pod (another container on the same network): nothing to connect to.
  const { stdout: podIp } = await docker(["inspect", "-f", `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`, names.pod]);
  const outside = await inPod(`
    import { connect } from 'node:net';
    const tryPort = (port) => new Promise((resolve) => { const s = connect({ host: process.argv[1], port, timeout: 3000 });
      s.on('connect', () => { s.destroy(); resolve('open'); }); s.on('error', (e) => resolve(e.code)); s.on('timeout', () => { s.destroy(); resolve('timeout'); }); });
    console.log(JSON.stringify({ intake: await tryPort(8080), metrics: await tryPort(9598) }));`, [podIp.trim()], { outside: true });
  record("external access refused", outside.intake === "ECONNREFUSED" && outside.metrics === "ECONNREFUSED", JSON.stringify(outside));

  // 4. Inside the pod, the token decides: none, wrong, another cluster's, and through the proxy with forced config.
  const intake = "http://127.0.0.1:8080/kong";
  const before = await rows();
  const answers = {
    none: (await post(intake, "", event(randomBytes(16).toString("hex")))).status,
    wrong: (await post(intake, randomBytes(24).toString("hex"), event(randomBytes(16).toString("hex")))).status,
    otherCluster: (await post(intake, otherClusterToken, event(randomBytes(16).toString("hex")))).status,
    proxyClientHeader: (await post("http://127.0.0.1:8000/forced", randomBytes(24).toString("hex"), event(randomBytes(16).toString("hex")))).status,
    proxyNoHeader: (await post("http://127.0.0.1:8000/forced", "", event(randomBytes(16).toString("hex")))).status,
  };
  record("token required", Object.values(answers).every((s) => s === 401), JSON.stringify(answers));
  // Kong logs its own two /forced requests (legitimate platform events, status 401); none of the refused bodies lands.
  await rowsSettle(before + 2, "refused events");
  const forcedRows = await query(`SELECT path, status FROM gromesh.requests WHERE environment_id = '${instanceId}' AND path != '/traffic' FORMAT JSONEachRow`);
  record("refused events not written", forcedRows.split("\n").map((l) => JSON.parse(l)).every((r) => r.path === "/forced" && r.status === 401), forcedRows.replaceAll("\n", " "));

  // 5. With the token: another instance dropped; a replayed Kong event and a batch sent twice count once.
  const auth = token;
  const accepted = await rows();
  const foreign = randomUUID();
  const forged = await post(intake, auth, event(randomBytes(16).toString("hex"), foreign));
  const replay = await post(intake, auth, event(kongIds[0]));
  const fresh = randomBytes(16).toString("hex");
  const twice = [await post(intake, auth, event(fresh)), await post(intake, auth, event(fresh))];
  record("accepted by the intake", [forged, replay, ...twice].every((r) => r.status === 200), JSON.stringify([forged, replay, ...twice]));
  await rowsSettle(accepted + 1, "dedup and instance pin");
  record("replay and repeated batch deduplicated", (await rows()) === accepted + 1, `${await rows()} rows (+1: the fresh request once)`);
  record("another instance dropped", (await rows(foreign)) === 0 && Number(await query("SELECT count() FROM gromesh.requests WHERE environment_id NOT IN ('" + instanceId + "')")) === 0,
    "no row with any other environment_id");

  // 6. The probe's CAP-7 check against the real sidecar.
  record("probe CAP-7 passes", (await probe(intake, "pass")) === "ok", "POST without token answered 401");

  // 7. Rotation: the previous token is accepted during the window, then 401.
  setTokens(nextToken, token);
  await startCollector();
  const during = [(await post(intake, token, event(randomBytes(16).toString("hex")))).status,
    (await post(intake, nextToken, event(randomBytes(16).toString("hex")))).status];
  setTokens(nextToken);
  await startCollector();
  const after = [(await post(intake, token, event(randomBytes(16).toString("hex")))).status,
    (await post(intake, nextToken, event(randomBytes(16).toString("hex")))).status];
  record("rotation", during.join() === "200,200" && after.join() === "401,200", `window ${during}, after ${after}`);

  // Negative controls. (a) Without the auth block a forged event is written and the probe sees a CAP-7 violation.
  const open = join(work, "open");
  const original = readFileSync(join(root, "deploy/observability/vector/vector.yaml"), "utf8");
  const stripped = original.replace(/    # Only this cluster's gateways[\s\S]*?got == previous\)\n/, "");
  assert.notEqual(stripped, original, "negative control must remove the auth block");
  await exec("mkdir", ["-p", open]);
  writeFileSync(join(open, "vector.yaml"), stripped);
  writeFileSync(join(open, "entrypoint.sh"), readFileSync(join(root, "deploy/observability/vector/entrypoint.sh")));
  await startCollector({ config: open });
  const beforeOpen = await rows();
  const forgedOpen = (await post(intake, "", event(randomBytes(16).toString("hex")))).status;
  await rowsSettle(beforeOpen + 1, "control: forged event without auth");
  record("control: no auth writes a forged event", forgedOpen === 200 && (await rows()) === beforeOpen + 1, `status ${forgedOpen}`);
  record("control: probe CAP-7 violation without auth", (await probe(intake, "violation")) === "ok", "POST without token answered 200");
  // (b) Listening on 0.0.0.0 makes the intake reachable from another container: the exposure test catches it.
  await startCollector({ address: "0.0.0.0:8080" });
  const exposed = await inPod(`
    import { connect } from 'node:net';
    const s = connect({ host: process.argv[1], port: 8080, timeout: 3000 });
    s.on('connect', () => { s.destroy(); console.log(JSON.stringify('open')); }); s.on('error', (e) => console.log(JSON.stringify(e.code)));`, [podIp.trim()], { outside: true });
  record("control: 0.0.0.0 is reachable from outside", exposed === "open", exposed);

  // No credential in any container log.
  const logs = (await Promise.all([names.collector, names.kong, names.ch].map((n) => docker(["logs", n]).then((r) => r.stdout + r.stderr, () => ""))))
    .join("\n");
  record("no secret in logs", secrets.every((s) => !logs.includes(s)), "collector, kong and clickhouse logs");
}

try {
  await main();
} catch (error) {
  throw new Error(redact(error?.stack ?? error));
} finally {
  for (const n of Object.values(names)) await docker(["rm", "-f", n]).catch(() => {});
  await docker(["network", "rm", net]).catch(() => {});
  const text = JSON.stringify({ kongImage: KONG_IMAGE, vectorImage: VECTOR_IMAGE, results }, null, 2);
  assert.ok(secrets.every((s) => !text.includes(s)), "evidence must not carry a secret");
  writeFileSync(join(out, "X4-collector-sidecar-results.json"), text);
  console.log(`N2-X4 collector sidecar: ${results.filter((r) => r.ok).length}/${results.length} checks passed (${join(out, "X4-collector-sidecar-results.json")})`);
}
