#!/usr/bin/env node
// N3 v2 delivery with real components, Docker only (no Kubernetes): Postgres, the control plane, and one data plane
// "pod" laid out as the chart's Workspaces mode (a network holder, kong under kong-supervisor, the agent and the
// isolation-probe in its network namespace, the same volumes and owners). Flow (D4): Publish Release (also with the
// mode off) → Create Deployment → Apply → Verify Convergence, then traffic A×B and the negative controls, and a v1
// cluster beside it for the regression. It proves application and convergence, not isolation: Docker has no
// NetworkPolicy, so the probe's capability targets here are closed ports, never evidence of CAP-1…CAP-7.
//   CP_IMAGE=… AGENT_IMAGE=… KONG_IMAGE=<repo>@sha256:… [V2FLOW_OUT=<dir>] node e2e/v2-flow.mjs
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { NODE_IMAGE, pullImages } from "./docker-images.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const IMAGES = { cp: process.env.CP_IMAGE, agent: process.env.AGENT_IMAGE, kong: process.env.KONG_IMAGE, pg: "postgres:16-alpine", echo: "traefik/whoami:v1.10.3" };
for (const [k, v] of Object.entries(IMAGES)) if (!v) throw new Error(`${k.toUpperCase()}_IMAGE is required`);
if (!/@sha256:[0-9a-f]{64}$/.test(IMAGES.kong)) throw new Error("KONG_IMAGE must be pinned by digest");

const RUN = randomUUID().slice(0, 8);
const PREFIX = `gromesh-v2flow-${RUN}`;
const out = process.env.V2FLOW_OUT ?? mkdtempSync(join(tmpdir(), "gromesh-v2flow-out-"));
const dir = mkdtempSync(join(tmpdir(), "gromesh-v2flow-"));
const containers = [];
const volumes = [];
let network = null;

const docker = (args, { input, timeout = 300_000, allowFail = false } = {}) => new Promise((resolve, reject) => {
  const child = execFile("docker", args, { cwd: root, timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error && !allowFail) reject(new Error(`docker ${args.slice(0, 3).join(" ")}: ${redact(stderr || error.message)}`.slice(0, 4000)));
    else resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
  });
  if (input !== undefined) { child.stdin.end(input); }
});

// --- report -------------------------------------------------------------------------------------------------------
const secrets = new Set();
function redact(text) {
  let s = String(text);
  for (const v of secrets) if (v && v.length >= 6) s = s.split(v).join("REDACTED");
  // Kong prints a fresh request-debug token at start; it would let anyone reaching that proxy turn on request debugging.
  return s.replace(/(token for request debugging: )[0-9a-f-]{36}/g, "$1REDACTED");
}
// What a pass of this run can and cannot stand for: Docker has no NetworkPolicy, CNI or pod lifecycle.
const SCOPE = {
  provenInDocker: ["immutable release publication", "deployment separate from publication", "application by the agent",
    "revision and hash verification", "convergence on agent status and probe evidence", "v1 compatibility",
    "plugin behaviour on the real Kong"],
  notProvenInDocker: ["Kubernetes NetworkPolicy", "host/CNI isolation", "pod lifecycle", "CAP-1…CAP-7 in Kubernetes"],
};
const report = { startedAt: new Date().toISOString(), run: RUN, images: IMAGES, scope: SCOPE, steps: [], negative: [], findings: [], timeline: [] };
const save = () => writeFileSync(join(out, "results.json"), redact(JSON.stringify(report, null, 2)));
const log = (m) => console.log(redact(`${new Date().toISOString()} ${m}`));
const mark = (event, data = {}) => { report.timeline.push({ at: new Date().toISOString(), event, ...data }); log(`${event} ${JSON.stringify(data)}`); save(); };
function step(id, title) {
  const s = { id, title, result: "pending", facts: {}, failures: [] };
  report.steps.push(s);
  log(`--- ${id}: ${title}`);
  return s;
}
const expect = (s, ok, message) => { if (!ok) s.failures.push(message); return ok; };
const done = (s) => { s.result = s.failures.length ? "fail" : "pass"; save(); log(`${s.id}: ${s.result.toUpperCase()} ${JSON.stringify(s.facts)}${s.failures.map((f) => `\n  ${f}`).join("")}`); };
/** The protection must refuse: `ok` says whether it did. */
function negative(s, what, expected, observed, ok) {
  report.negative.push({ step: s.id, what, expected, observed, ok });
  if (!ok) s.failures.push(`negative control "${what}": expected ${expected}, observed ${observed}`);
}

async function waitFor(what, fn, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
  const began = Date.now();
  let last;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (error) { last = error; }
    if (Date.now() - began > timeoutMs) throw new Error(`${what}: not within ${timeoutMs} ms${last ? ` (${last.message})` : ""}`);
    await sleep(intervalMs);
  }
}

// --- containers and volumes ---------------------------------------------------------------------------------------
async function run(name, args) {
  const full = `${PREFIX}-${name}`;
  const id = (await docker(["run", "-d", "--name", full, "--label", `gromesh.v2flow=${RUN}`, ...args])).stdout.trim();
  containers.push(full);
  return full;
}
async function volume(name, { owner, mode = "0755" } = {}) {
  const full = `${PREFIX}-${name}`;
  await docker(["volume", "create", "--label", `gromesh.v2flow=${RUN}`, full]);
  volumes.push(full);
  if (owner) await docker(["run", "--rm", "-v", `${full}:/v`, NODE_IMAGE, "sh", "-c", `chown ${owner} /v && chmod ${mode} /v`]);
  return full;
}
async function teardown() {
  for (const c of [...containers].reverse()) await docker(["rm", "-f", c], { allowFail: true });
  for (const v of volumes) await docker(["volume", "rm", "-f", v], { allowFail: true });
  // Anything of this run that a crash left unnamed in the lists above.
  const left = (await docker(["ps", "-aq", "--filter", `label=gromesh.v2flow=${RUN}`], { allowFail: true })).stdout.trim().split("\n").filter(Boolean);
  if (left.length) await docker(["rm", "-f", ...left], { allowFail: true });
  const vleft = (await docker(["volume", "ls", "-q", "--filter", `label=gromesh.v2flow=${RUN}`], { allowFail: true })).stdout.trim().split("\n").filter(Boolean);
  if (vleft.length) await docker(["volume", "rm", "-f", ...vleft], { allowFail: true });
  if (network) await docker(["network", "rm", network], { allowFail: true });
  rmSync(dir, { recursive: true, force: true });
}
let tearing = null;
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { tearing ??= teardown().finally(() => process.exit(130)); });

// --- control plane ------------------------------------------------------------------------------------------------
const pgPassword = randomBytes(18).toString("base64url");
const admin = { email: "platform-admin@v2flow.test", password: randomBytes(18).toString("base64url") };
const cpEnv = {
  DATABASE_URL: `postgres://gromesh:${pgPassword}@postgres:5432/gromesh`,
  GROMESH_ENCRYPTION_KEY: `v2flow1:${randomBytes(32).toString("base64")}`,
  GROMESH_FINGERPRINT_KEY: randomBytes(32).toString("base64"),
  BOOTSTRAP_ADMIN_EMAIL: admin.email, BOOTSTRAP_ADMIN_PASSWORD: admin.password,
  MIGRATE_ON_START: "true", COOKIE_SECURE: "false", PORT: "3000", GROMESH_INSTANCE_STAGE: "dev",
  KONG_VALIDATOR_URL: "http://kong-validator:8001",
};
for (const v of [pgPassword, admin.password, cpEnv.GROMESH_ENCRYPTION_KEY, cpEnv.GROMESH_FINGERPRINT_KEY]) secrets.add(v);
let cpUrl = null;

async function startControlPlane(workspacesMode) {
  await docker(["rm", "-f", `${PREFIX}-cp`], { allowFail: true });
  const env = { ...cpEnv, ...(workspacesMode ? { GROMESH_EXPERIMENTAL_WORKSPACES: "lab" } : {}) };
  // Secrets reach the container through an env file, never argv.
  const envFile = join(dir, "cp.env");
  writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n"), { mode: 0o600 });
  const name = await run("cp", ["--network", network, "--network-alias", "control-plane", "--env-file", envFile, "-p", "127.0.0.1::3000", IMAGES.cp]);
  if (containers.filter((c) => c === name).length > 1) containers.splice(containers.lastIndexOf(name), 1);
  const port = (await docker(["port", name, "3000/tcp"])).stdout.trim().split("\n")[0].split(":").pop();
  cpUrl = `http://127.0.0.1:${port}`;
  await waitFor("control plane /healthz", async () => (await fetch(`${cpUrl}/healthz`)).status === 200, { timeoutMs: 120_000 });
}

async function req(method, path, { body, session, token, csrf = true } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (session) { headers.cookie = session.cookie; if (csrf) headers["x-csrf-token"] = session.csrf; }
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${cpUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
}
async function ok(method, path, opts) {
  const r = await req(method, path, opts);
  if (![200, 201, 202, 204].includes(r.status)) throw new Error(`${method} ${path} answered ${r.status}: ${redact(JSON.stringify(r.body))}`);
  return r.body;
}
async function login() {
  const r = await req("POST", "/api/v1/auth/login", { body: admin });
  if (r.status !== 200) throw new Error(`login: ${r.status}`);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("gromesh_session="));
  secrets.add(cookie.split("=")[1]);
  const { csrfToken } = await ok("GET", "/api/v1/auth/csrf", { session: { cookie } });
  return { cookie, csrf: csrfToken };
}
async function sql(query) {
  const { stdout } = await docker(["exec", "-i", `${PREFIX}-postgres`, "psql", "-U", "gromesh", "-d", "gromesh", "-v", "ON_ERROR_STOP=1", "-At", "-f", "-"],
    { input: `select coalesce(json_agg(t), '[]'::json) from (${query}) t;\n`, timeout: 30_000 });
  return JSON.parse(stdout.trim());
}

// --- data plane pods ----------------------------------------------------------------------------------------------
/** The listeners.conf of the chart's ConfigMap (the agent reaches Kong only through the shared unix sockets). */
const listenersConf = () => readFileSync(join(root, "deploy/helm/data-plane/files/kong/listeners.conf"), "utf8");

/**
 * One data plane pod in Workspaces mode: `net` holds the network namespace (the pod sandbox); seed-config and
 * isolation-install run first; kong (kong-supervisor as PID 1), agent and isolation-probe share it.
 */
async function workspacesPod(name, { registrationToken, clusterId, instanceId, trust, checks }) {
  const podUid = randomUUID();
  const v = {
    snapshot: await volume(`${name}-snapshot`, { owner: "1001:1001" }),
    agentState: await volume(`${name}-agent-state`, { owner: "1001:1001" }),
    kongPrefix: await volume(`${name}-kong-prefix`, { owner: "1001:1001" }),
    kongTmp: await volume(`${name}-kong-tmp`, { owner: "1001:1001", mode: "1777" }),
    kongAdmin: await volume(`${name}-kong-admin`, { owner: "1001:1001", mode: "2775" }),
    isolation: await volume(`${name}-isolation`, { owner: "1002:1001", mode: "2755" }),
    kongState: await volume(`${name}-kong-state`, { owner: "1001:1001", mode: "2755" }),
    bin: await volume(`${name}-isolation-bin`, { owner: "1001:1001" }),
    handoff: await volume(`${name}-handoff`, { owner: "1001:1001", mode: "2775" }),
    version: await volume(`${name}-kong-version`, { owner: "1001:1001" }),
  };
  const cfg = join(dir, `${name}-config`);
  mkdirSync(join(cfg, "kong"), { recursive: true });
  mkdirSync(join(cfg, "probe"), { recursive: true });
  writeFileSync(join(cfg, "kong", "listeners.conf"), listenersConf(), { mode: 0o644 });
  writeFileSync(join(cfg, "probe", "probe.json"), JSON.stringify({ checks }), { mode: 0o644 });
  writeFileSync(join(cfg, "probe", "instance-keys.json"), JSON.stringify({ keys: trust }), { mode: 0o644 });
  const tokenFile = join(dir, `${name}.env`);
  writeFileSync(tokenFile, `GROMESH_REGISTRATION_TOKEN=${registrationToken}\n`, { mode: 0o600 });

  const net = await run(`${name}-net`, ["--network", network, "-p", "127.0.0.1::8000", "--entrypoint", "sleep", NODE_IMAGE, "infinity"]);
  const ns = `container:${net}`;
  // Init containers.
  await docker(["run", "--rm", "--user", "1001:1001", "--read-only", "-v", `${v.snapshot}:/kong/declarative`, "-v", `${v.version}:/gromesh/kong-version`,
    "--entrypoint", "/bin/sh", IMAGES.kong, "-ec",
    `[ -e /kong/declarative/kong.json ] || printf '%s\\n' '{"_format_version":"3.0"}' > /kong/declarative/kong.json; luajit -e 'io.write(dofile("/usr/local/share/lua/5.1/kong/meta.lua")._VERSION)' > /gromesh/kong-version/version`]);
  await docker(["run", "--rm", "--user", "1001:1001", "--read-only", "-v", `${v.bin}:/isolation-bin`, "--entrypoint", "/gromesh/isolation-bin/isolation-probe", IMAGES.agent, "install", "/isolation-bin"]);

  const env = (pairs) => Object.entries(pairs).flatMap(([k, val]) => ["-e", `${k}=${val}`]);
  const kong = await run(`${name}-kong`, ["--network", ns, "--user", "1001:1001", "--read-only",
    "-v", `${v.snapshot}:/kong/declarative:ro`, "-v", `${v.kongPrefix}:/kong_prefix`, "-v", `${v.kongTmp}:/tmp`, "-v", `${v.kongAdmin}:/kong/admin`,
    "-v", `${join(cfg, "kong")}:/etc/gromesh/kong:ro`, "-v", `${v.isolation}:/gromesh/isolation:ro`, "-v", `${v.kongState}:/gromesh/kong-state`,
    "-v", `${v.bin}:/gromesh/isolation-bin:ro`,
    ...env({ KONG_DATABASE: "off", KONG_DECLARATIVE_CONFIG: "/kong/declarative/kong.json", KONG_ADMIN_LISTEN: "off", KONG_ADMIN_GUI_LISTEN: "off",
      KONG_STATUS_LISTEN: "off", KONG_NGINX_HTTP_INCLUDE: "/etc/gromesh/kong/listeners.conf", KONG_PROXY_LISTEN: "0.0.0.0:8000",
      KONG_PREFIX: "/kong_prefix", KONG_NGINX_DAEMON: "off", KONG_PROXY_ACCESS_LOG: "/dev/stdout", KONG_PROXY_ERROR_LOG: "/dev/stderr",
      KONG_PLUGINS: "bundled,gromesh-workspace,gromesh-route-guard", GROMESH_POD_UID: podUid, KONG_NGINX_MAIN_ENV: "GROMESH_POD_UID",
      GROMESH_KONG_STATE_FILE: "/gromesh/kong-state/kong-state.json", KONG_NGINX_WORKER_PROCESSES: "1" }),
    "--entrypoint", "/gromesh/isolation-bin/kong-supervisor", IMAGES.kong, "--", "/bin/sh", "-ec",
    "rm -f /kong/admin/admin.sock /kong/admin/status.sock && exec /usr/local/bin/gromesh-entrypoint kong docker-start"]);
  const agent = await run(`${name}-agent`, ["--network", ns, "--user", "1001:1001", "--read-only", "--env-file", tokenFile,
    "-v", `${v.snapshot}:/kong/declarative`, "-v", `${v.agentState}:/var/lib/gromesh`, "-v", `${v.kongAdmin}:/kong/admin`,
    "-v", `${v.handoff}:/gromesh/handoff`, "-v", `${v.version}:/gromesh/kong-version:ro`,
    ...env({ GROMESH_CP_URL: "http://control-plane:3000", GROMESH_NODE_ID: `${name}-${RUN}`, KONG_ADMIN_URL: "unix:///kong/admin/admin.sock",
      KONG_STATUS_URL: "unix:///kong/admin/status.sock", SNAPSHOT_PATH: "/kong/declarative/kong.json", GROMESH_STATE_DIR: "/var/lib/gromesh",
      GROMESH_HANDOFF_DIR: "/gromesh/handoff", GROMESH_INSTANCE_ID: instanceId, GROMESH_KONG_VERSION_FILE: "/gromesh/kong-version/version",
      GROMESH_POD_UID: podUid, GROMESH_POD_NAME: name, GROMESH_NODE_NAME: "docker-desktop" }),
    IMAGES.agent]);
  const probe = await run(`${name}-probe`, ["--network", ns, "--user", "1002:1001", "--read-only",
    "-v", `${v.isolation}:/gromesh/isolation`, "-v", `${v.handoff}:/gromesh/handoff`, "-v", `${join(cfg, "probe")}:/etc/gromesh:ro`,
    "-v", `${v.kongState}:/gromesh/kong-state:ro`,
    ...env({ GROMESH_POD_UID: podUid, GROMESH_CLUSTER_ID: clusterId, GROMESH_INSTANCE_ID: instanceId, GROMESH_INSTANCE_KEYS: "/etc/gromesh/instance-keys.json",
      GROMESH_PROBE_CONFIG: "/etc/gromesh/probe.json", GROMESH_KONG_STATE_FILE: "/gromesh/kong-state/kong-state.json" }),
    "--entrypoint", "/gromesh/isolation-bin/isolation-probe", IMAGES.agent]);
  const port = (await docker(["port", net, "8000/tcp"])).stdout.trim().split("\n")[0].split(":").pop();
  return { name, podUid, nodeId: `${name}-${RUN}`, net, kong, agent, probe, volumes: v, proxy: `http://127.0.0.1:${port}` };
}

/** A v1 pod as before Workspaces: Kong with its Admin API on the pod's loopback and the agent without a handoff. */
async function v1Pod(name, { registrationToken }) {
  const snapshot = await volume(`${name}-snapshot`, { owner: "1001:1001" });
  const state = await volume(`${name}-agent-state`, { owner: "1001:1001" });
  const version = await volume(`${name}-kong-version`, { owner: "1001:1001" });
  const tokenFile = join(dir, `${name}.env`);
  writeFileSync(tokenFile, `GROMESH_REGISTRATION_TOKEN=${registrationToken}\n`, { mode: 0o600 });
  await docker(["run", "--rm", "--user", "1001:1001", "-v", `${snapshot}:/kong/declarative`, "-v", `${version}:/gromesh/kong-version`, "--entrypoint", "/bin/sh", IMAGES.kong, "-ec",
    `printf '%s\\n' '{"_format_version":"3.0"}' > /kong/declarative/kong.json; luajit -e 'io.write(dofile("/usr/local/share/lua/5.1/kong/meta.lua")._VERSION)' > /gromesh/kong-version/version`]);
  const kong = await run(`${name}-kong`, ["--network", network, "-p", "127.0.0.1::8000", "-v", `${snapshot}:/kong/declarative:ro`,
    "-e", "KONG_DATABASE=off", "-e", "KONG_DECLARATIVE_CONFIG=/kong/declarative/kong.json", "-e", "KONG_ADMIN_LISTEN=127.0.0.1:8001", "-e", "KONG_STATUS_LISTEN=127.0.0.1:8100",
    "-e", "KONG_PROXY_LISTEN=0.0.0.0:8000", "-e", "KONG_NGINX_WORKER_PROCESSES=1", IMAGES.kong]);
  const agent = await run(`${name}-agent`, ["--network", `container:${kong}`, "--user", "1001:1001", "--env-file", tokenFile,
    "-v", `${snapshot}:/kong/declarative`, "-v", `${state}:/var/lib/gromesh`, "-v", `${version}:/gromesh/kong-version:ro`,
    "-e", "GROMESH_CP_URL=http://control-plane:3000", "-e", `GROMESH_NODE_ID=${name}-${RUN}`, "-e", "KONG_ADMIN_URL=http://127.0.0.1:8001",
    "-e", "KONG_STATUS_URL=http://127.0.0.1:8100", "-e", "SNAPSHOT_PATH=/kong/declarative/kong.json", "-e", "GROMESH_STATE_DIR=/var/lib/gromesh",
    "-e", "GROMESH_KONG_VERSION_FILE=/gromesh/kong-version/version", IMAGES.agent]);
  const port = (await docker(["port", kong, "8000/tcp"])).stdout.trim().split("\n")[0].split(":").pop();
  return { name, kong, agent, proxy: `http://127.0.0.1:${port}`, nodeId: `${name}-${RUN}`, state };
}

/** A file of a volume, read from a throwaway container (the volumes live in Docker's VM). */
async function readVolume(vol, path) {
  const r = await docker(["run", "--rm", "-v", `${vol}:/v:ro`, NODE_IMAGE, "cat", `/v/${path}`], { allowFail: true });
  return r.code === 0 ? r.stdout : null;
}
/** One request to Kong's admin or status socket, from a throwaway node container as the kong user (no curl in Kong). */
async function kongSocket(pod, sock, method, path, body) {
  // The body (a config with key-auth keys and JWT secrets) reaches the helper on stdin only, never in its argv.
  const script = `const h=require("http");let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const r=h.request({socketPath:"/kong/admin/${sock}.sock",method:"${method}",path:${JSON.stringify(path)},headers:b?{"content-type":"application/json","content-length":Buffer.byteLength(b)}:{}},res=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>{process.stdout.write(JSON.stringify({status:res.statusCode,body:d}))})});r.on("error",e=>{process.stdout.write(JSON.stringify({status:0,body:String(e)}))});r.end(b)})`;
  const r = await docker(["run", "--rm", "-i", "--user", "1001:1001", "-v", `${pod.volumes.kongAdmin}:/kong/admin`, NODE_IMAGE, "node", "-e", script], { input: body ?? "", allowFail: true });
  try { return JSON.parse(r.stdout); } catch { return { status: 0, body: r.stderr.slice(0, 300) }; }
}
async function kongStatus(pod) {
  const r = await kongSocket(pod, "status", "GET", "/status");
  try { return r.status === 200 ? JSON.parse(r.body) : null; } catch { return null; }
}
async function kongAdmin(pod, path) {
  const r = await kongSocket(pod, "admin", "GET", path);
  try { return r.status === 200 ? JSON.parse(r.body) : null; } catch { return null; }
}
async function httpStatus(url, headers = {}) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
    await r.arrayBuffer();
    return r.status;
  } catch (error) { return error?.name === "TimeoutError" ? "timeout" : "down"; }
}
const b64u = (x) => Buffer.from(x).toString("base64url");
function hs256(key, secret) {
  const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64u(JSON.stringify({ iss: key, exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `${h}.${p}.${createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`;
}
const nodes = () => sql("select n.node_id, c.delivery_protocol, n.epoch, n.applied_revision, n.failed_revision, n.failure_reason, n.evidence, n.verified_revision, n.kong_config_hash, n.kong_healthy from cluster_nodes n join clusters c on c.id = n.cluster_id order by n.node_id");
const latestDeployment = async () => (await sql(`select d.revision, d.epoch, d.config_hash, d.kong_config_hash, d.expected_nodes,
  (select s.state from deployment_states s where s.revision = d.revision and s.epoch = d.epoch order by s.seq desc limit 1) as state
  from deployments d order by d.epoch desc, d.revision desc limit 1`))[0];

// --- the run ------------------------------------------------------------------------------------------------------
const ctx = {};

async function setup() {
  const s = step("setup", "Postgres, control plane (Workspaces mode off), fixtures through the API");
  await pullImages([IMAGES.pg, IMAGES.echo, NODE_IMAGE, IMAGES.kong]);
  network = `${PREFIX}-net`;
  await docker(["network", "create", "--label", `gromesh.v2flow=${RUN}`, network]);
  await run("echo", ["--network", network, "--network-alias", "echo", IMAGES.echo]);
  const pgEnv = join(dir, "pg.env");
  writeFileSync(pgEnv, `POSTGRES_DB=gromesh\nPOSTGRES_USER=gromesh\nPOSTGRES_PASSWORD=${pgPassword}\n`, { mode: 0o600 });
  await run("postgres", ["--network", network, "--network-alias", "postgres", "--env-file", pgEnv, IMAGES.pg]);
  await waitFor("postgres", async () => (await docker(["exec", `${PREFIX}-postgres`, "pg_isready", "-U", "gromesh"], { allowFail: true })).code === 0, { timeoutMs: 60_000 });
  // Plugin validation by the same Kong image, Admin API only on the private network (as in deploy/compose).
  await run("kong-validator", ["--network", network, "--network-alias", "kong-validator", "-e", "KONG_DATABASE=off", "-e", "KONG_PROXY_LISTEN=off",
    "-e", "KONG_ADMIN_LISTEN=0.0.0.0:8001", "-e", "KONG_STATUS_LISTEN=off", "-e", "KONG_NGINX_WORKER_PROCESSES=1",
    "-e", "KONG_PLUGINS=bundled,gromesh-workspace,gromesh-route-guard", IMAGES.kong]);
  await waitFor("kong-validator", async () => (await docker(["exec", `${PREFIX}-kong-validator`, "kong", "health"], { allowFail: true })).code === 0, { timeoutMs: 90_000 });
  await startControlPlane(false);
  ctx.session = await login();
  const api = (m, p, body) => ok(m, p, { session: ctx.session, body });
  ctx.env = {};
  for (const label of ["A", "B"]) {
    const env = await api("POST", "/api/v1/environments", { name: `v2flow-${label.toLowerCase()}` });
    const svc = await api("POST", `/api/v1/environments/${env.id}/services`, { name: "svc", protocol: "http", host: "echo", port: 80 });
    const rKey = await api("POST", `/api/v1/environments/${env.id}/routes`, { name: "key", serviceId: svc.id, paths: ["/key"], stripPath: false });
    const rJwt = await api("POST", `/api/v1/environments/${env.id}/routes`, { name: "jwt", serviceId: svc.id, paths: ["/jwt"], stripPath: false });
    const rBasic = await api("POST", `/api/v1/environments/${env.id}/routes`, { name: "basic", serviceId: svc.id, paths: ["~/basic/[0-9]+$"], stripPath: false });
    const rAnon = await api("POST", `/api/v1/environments/${env.id}/routes`, { name: "anon", serviceId: svc.id, paths: ["/anon"], stripPath: false });
    // Same logical names in both workspaces: consumer "app" and "guest".
    const app = await api("POST", `/api/v1/environments/${env.id}/consumers`, { username: "app" });
    const guest = await api("POST", `/api/v1/environments/${env.id}/consumers`, { username: "guest" });
    await api("POST", `/api/v1/environments/${env.id}/plugins`, { name: "key-auth", scope: { routeId: rKey.id }, config: {} });
    await api("POST", `/api/v1/environments/${env.id}/plugins`, { name: "jwt", scope: { routeId: rJwt.id }, config: {} });
    await api("POST", `/api/v1/environments/${env.id}/plugins`, { name: "basic-auth", scope: { routeId: rBasic.id }, config: {} });
    await api("POST", `/api/v1/environments/${env.id}/plugins`, { name: "key-auth", scope: { routeId: rAnon.id }, config: { anonymous: guest.id } });
    const key = await api("POST", `/api/v1/environments/${env.id}/consumers/${app.id}/key-auth`, {});
    const jwt = await api("POST", `/api/v1/environments/${env.id}/consumers/${app.id}/jwt`, {});
    const basic = { username: `app-${label.toLowerCase()}-${RUN}`, password: randomBytes(12).toString("base64url") };
    await api("POST", `/api/v1/environments/${env.id}/consumers/${app.id}/basic-auth`, basic);
    for (const x of [key.key, jwt.secret, basic.password]) secrets.add(x);
    ctx.env[label] = { id: env.id, key: key.key, jwt: { key: jwt.key, secret: jwt.secret }, basic };
  }
  const cluster = await api("POST", `/api/v1/environments/${ctx.env.A.id}/clusters`, { name: "v2flow-dp" });
  secrets.add(cluster.registrationToken);
  ctx.cluster = { id: cluster.id, token: cluster.registrationToken };
  const key = await api("POST", "/api/v2/instance/signing-keys", { validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString() });
  ctx.trust = [{ kid: key.kid, publicKey: key.publicKey }];
  s.facts = { workspaces: Object.keys(ctx.env).length, clusterId: ctx.cluster.id, kid: key.kid };
  expect(s, typeof key.kid === "string" && typeof key.publicKey === "string", "signing key without kid/publicKey");
  done(s);
}

async function modeOff() {
  const s = step("C1-d4-off", "Mode off: publishRelease is allowed and deploys nothing; createDeployment and the v2 switch refuse");
  const rel = await req("POST", `/api/v2/workspaces/${ctx.env.A.id}/releases`, { session: ctx.session, body: { message: "v2flow: mode off" } });
  s.facts.publishStatus = rel.status;
  expect(s, rel.status === 201, `publishRelease with the mode off answered ${rel.status}: ${JSON.stringify(rel.body)}`);
  const count = (await sql("select count(*)::int as n from deployments"))[0].n;
  expect(s, count === 0, `a release with the mode off created ${count} deployments`);
  const dep = await req("POST", "/api/v2/deployments", { session: ctx.session, body: { expectedRevision: null, reason: "v2flow: mode off" } });
  negative(s, "createDeployment with the mode off", "409 workspaces-mode-disabled", `${dep.status} ${dep.body?.code ?? ""}`, dep.status === 409 && /workspaces-mode-disabled/.test(JSON.stringify(dep.body)));
  const sw = await req("PUT", `/api/v2/clusters/${ctx.cluster.id}/delivery-protocol`, { session: ctx.session, body: { protocol: "v2", reason: "v2flow: mode off" } });
  negative(s, "v2 switch with the mode off", "409 workspaces-mode-disabled", `${sw.status} ${sw.body?.code ?? ""}`, sw.status === 409 && /workspaces-mode-disabled/.test(JSON.stringify(sw.body)));
  const proto = (await sql(`select delivery_protocol from clusters where id = '${ctx.cluster.id}'`))[0].delivery_protocol;
  expect(s, proto === "v1", `cluster protocol after the refused switch: ${proto}`);
  ctx.instanceId = (await sql("select id from instance"))[0]?.id;
  s.facts.instanceId = ctx.instanceId;
  expect(s, Boolean(ctx.instanceId), "no instance row after the first release");
  done(s);
}

function probeChecks() {
  // Closed ports of the echo backend stand in for every forbidden target (Docker has no NetworkPolicy: not a CAP proof).
  return [
    { capability: "CAP-1", kind: "tcp", name: "forbidden pod", address: "echo:81" },
    { capability: "CAP-1", kind: "tcp-open", name: "allowed backend", address: "echo:80" },
    { capability: "CAP-2", kind: "tcp", name: "node", address: "echo:82" },
    { capability: "CAP-3", kind: "tcp", name: "metadata", address: "echo:83" },
    { capability: "CAP-4", kind: "dns", name: "dns", host: "echo" },
    { capability: "CAP-4", kind: "tcp", name: "rebinding", address: "echo:84" },
    { capability: "CAP-5", kind: "tcp", name: "internal service", address: "echo:85" },
    { capability: "CAP-6", kind: "http", name: "agent metrics", url: "http://127.0.0.1:9100/metrics", expectStatus: 403 },
    { capability: "CAP-7", kind: "http", name: "collector token", url: "http://127.0.0.1:8080/kong", method: "POST", expectStatus: 401 },
  ];
}

async function podUp() {
  const s = step("pod", "Workspaces pod: registration, admission, probe rounds (cluster still v1)");
  ctx.pod = await workspacesPod("ws", { registrationToken: ctx.cluster.token, clusterId: ctx.cluster.id, instanceId: ctx.instanceId, trust: ctx.trust, checks: probeChecks() });
  const registered = await waitFor("node registered", async () => (await nodes()).find((n) => n.node_id === ctx.pod.nodeId), { timeoutMs: 90_000 });
  s.facts.registered = registered.node_id;
  const iso = await waitFor("pod admitted with a conclusive round", async () => {
    const r = await req("GET", `/api/v2/clusters/${ctx.cluster.id}/isolation`, { session: ctx.session });
    const p = r.body?.pods?.find((x) => x.podUid === ctx.pod.podUid);
    return p && p.admission === "open" && p.lastSeq > 0 ? p : null;
  }, { timeoutMs: 180_000, intervalMs: 2000 });
  s.facts.isolation = { state: iso.state, admission: iso.admission, servedState: iso.servedState, lastSeq: iso.lastSeq, failedCapabilities: iso.failedCapabilities };
  done(s);
}

async function deliver() {
  const s = step("C2-C3", "Publish (mode on) → createDeployment → v2 switch → gate → apply → Kong md5 → applied.json → probe → verified");
  await startControlPlane(true);
  ctx.session = await login();
  const releases = {};
  for (const [label, e] of Object.entries(ctx.env)) {
    const r = await req("POST", `/api/v2/workspaces/${e.id}/releases`, { session: ctx.session, body: { message: `v2flow ${label}` } });
    // A's draft was already frozen with the mode off: the same content is not published twice (409), that release is active.
    if (r.status === 409 && /Nothing to publish/.test(r.body?.detail ?? "")) releases[label] = (await ok("GET", `/api/v2/workspaces/${e.id}/releases`, { session: ctx.session })).at(-1);
    else if (r.status === 201) releases[label] = r.body;
    else throw new Error(`publishRelease ${label}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  const before = (await sql("select count(*)::int as n from deployments"))[0].n;
  expect(s, before === 0, `publishRelease created ${before} deployments`);
  s.facts.releases = Object.fromEntries(Object.entries(releases).map(([k, r]) => [k, { version: r.version, contentDigest: r.contentDigest }]));
  // Immutable: the release row refuses UPDATE.
  const upd = await docker(["exec", "-i", `${PREFIX}-postgres`, "psql", "-U", "gromesh", "-d", "gromesh", "-c", "update releases set message = 'x'"], { allowFail: true });
  negative(s, "UPDATE of a release", "refused by the trigger", upd.code === 0 ? "accepted" : "refused", upd.code !== 0);

  // While the cluster is v1 the deployment has no node to deliver to: it never converges (D-1).
  const dep1 = await ok("POST", "/api/v2/deployments", { session: ctx.session, body: { expectedRevision: null, reason: "v2flow: cluster still v1" } });
  await sleep(3000);
  const d1 = await latestDeployment();
  s.facts.deploymentWhileV1 = { revision: dep1.revision, state: d1.state, expectedNodes: d1.expected_nodes };
  negative(s, "deployment while every cluster is v1", "not converged (no expected node)", d1.state, d1.state !== "converged");
  const v1snap = await fetchV1Snapshot();
  s.facts.v1SnapshotWhileV1 = v1snap.status;

  const sw = await ok("PUT", `/api/v2/clusters/${ctx.cluster.id}/delivery-protocol`, { session: ctx.session, body: { protocol: "v2", reason: "v2flow: switch the lab cluster to v2" } });
  s.facts.switch = sw.deliveryProtocol;
  const t0 = Date.now();
  const gate = await waitFor("activation gate → v2", async () => (await sql(`select delivery_protocol from clusters where id = '${ctx.cluster.id}'`))[0].delivery_protocol === "v2", { timeoutMs: 240_000, intervalMs: 2000 });
  s.facts.gateMs = Date.now() - t0;
  const applied = await waitFor("applied.json", async () => { const t = await readVolume(ctx.pod.volumes.handoff, "applied.json"); return t ? JSON.parse(t) : null; }, { timeoutMs: 120_000, intervalMs: 1000 });
  const dep = await latestDeployment();
  const status = await kongStatus(ctx.pod);
  s.facts.applied = applied;
  s.facts.deployment = { revision: dep.revision, epoch: dep.epoch, configHash: dep.config_hash, kongConfigHash: dep.kong_config_hash };
  s.facts.kongConfigurationHash = status?.configuration_hash;
  expect(s, status?.configuration_hash === dep.kong_config_hash, `Kong configuration_hash ${status?.configuration_hash} ≠ CP kongConfigHash ${dep.kong_config_hash}`);
  expect(s, applied.kongConfigHash === dep.kong_config_hash && applied.revision === dep.revision && applied.hash === dep.config_hash, "applied.json does not match the deployment");
  expect(s, applied.podUid === ctx.pod.podUid && applied.clusterId === ctx.cluster.id && applied.instanceId === ctx.instanceId, "applied.json names another pod, cluster or instance");
  const conv = await waitFor("convergence verified", async () => {
    const n = (await nodes()).find((x) => x.node_id === ctx.pod.nodeId);
    const d = await latestDeployment();
    return n?.evidence === "verified" && d.state === "converged" ? { n, d } : null;
  }, { timeoutMs: 120_000, intervalMs: 2000 }).catch((e) => { s.failures.push(e.message); return null; });
  if (conv) s.facts.converged = { evidence: conv.n.evidence, appliedRevision: conv.n.applied_revision, verifiedRevision: conv.n.verified_revision, state: conv.d.state };
  // The probe's signed report carries the applied revision only with the served hash.
  const iso = (await req("GET", `/api/v2/clusters/${ctx.cluster.id}/isolation`, { session: ctx.session })).body?.pods?.find((x) => x.podUid === ctx.pod.podUid);
  s.facts.probe = { state: iso?.state, servedState: iso?.servedState };
  ctx.dep = dep;
  done(s);
}

async function fetchV1Snapshot() {
  const token = await nodeToken(ctx.pod);
  const r = await fetch(`${cpUrl}/agent/v1/snapshots/current`, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.text() };
}
async function nodeToken(pod) {
  const t = await readVolume(pod.volumes?.agentState ?? pod.state, "node-token");
  if (t) { secrets.add(t.trim()); return t.trim(); }
  const listing = (await docker(["run", "--rm", "-v", `${pod.volumes?.agentState ?? pod.state}:/v:ro`, NODE_IMAGE, "ls", "-la", "/v"], { allowFail: true })).stdout;
  throw new Error(`node token not found in the agent state: ${listing}`);
}

/** What each side holds for the latest revision: the node row, applied.json, the probe's last report and the agent's log. */
async function revisionDiag() {
  const applied = await readVolume(ctx.pod.volumes.handoff, "applied.json");
  const outbox = (await docker(["run", "--rm", "-v", `${ctx.pod.volumes.handoff}:/v:ro`, NODE_IMAGE, "sh", "-c", "ls /v/outbox | tail -1 | xargs -I{} cat /v/outbox/{}"], { allowFail: true })).stdout;
  let report = null;
  try { report = JSON.parse(Buffer.from(JSON.parse(outbox).payload, "base64url").toString()); } catch { /* none */ }
  const logs = await docker(["logs", "--tail", "15", ctx.pod.agent], { allowFail: true });
  return {
    node: (await nodes()).find((x) => x.node_id === ctx.pod.nodeId), deployment: await latestDeployment(), applied: applied ? JSON.parse(applied) : null,
    lastReport: report && { seq: report.seq, state: report.state, appliedRevision: report.appliedRevision, appliedEpoch: report.appliedEpoch, servedKongConfigHash: report.servedKongConfigHash, at: report.reportedAt ?? report.at },
    agentLog: redact(`${logs.stdout}${logs.stderr}`).split("\n").slice(-15),
  };
}

async function traffic() {
  const s = step("D1-traffic", "Traffic A×B on the v2 configuration (key-auth, jwt, basic-auth, anonymous, prefixes, regex)");
  const p = ctx.pod.proxy;
  const A = ctx.env.A, B = ctx.env.B;
  const slug = async (label) => (await sql(`select slug from workspaces where id = '${ctx.env[label].id}'`))[0].slug;
  const sa = await slug("A"), sb = await slug("B");
  const basic = (c) => `Basic ${Buffer.from(`${c.username}:${c.password}`).toString("base64")}`;
  const cases = [
    ["A key-auth own", `${p}/${sa}/key`, { apikey: A.key }, 200],
    ["B key-auth own", `${p}/${sb}/key`, { apikey: B.key }, 200],
    ["A key on B route", `${p}/${sb}/key`, { apikey: A.key }, 401],
    ["B key on A route", `${p}/${sa}/key`, { apikey: B.key }, 401],
    ["invalid key", `${p}/${sa}/key`, { apikey: "not-a-key" }, 401],
    ["A jwt own", `${p}/${sa}/jwt`, { authorization: `Bearer ${hs256(A.jwt.key, A.jwt.secret)}` }, 200],
    ["A jwt on B route", `${p}/${sb}/jwt`, { authorization: `Bearer ${hs256(A.jwt.key, A.jwt.secret)}` }, 401],
    ["A basic own (regex path)", `${p}/${sa}/basic/42`, { authorization: basic(A.basic) }, 200],
    ["B basic on A route", `${p}/${sa}/basic/42`, { authorization: basic(B.basic) }, 401],
    ["regex outside the pattern", `${p}/${sa}/basic/x`, { authorization: basic(A.basic) }, 404],
    ["A anonymous", `${p}/${sa}/anon`, {}, 200],
    ["path without a workspace prefix", `${p}/key`, { apikey: A.key }, 404],
  ];
  s.facts.cases = [];
  for (const [name, url, headers, want] of cases) {
    const got = await httpStatus(url, headers);
    s.facts.cases.push({ name, want, got });
    expect(s, got === want, `${name}: ${got}, expected ${want}`);
  }
  // key-auth with anonymous: a credential that does not authenticate here (B's key on A's route) is served as A's
  // anonymous consumer, never as B's: the upstream sees A's guest, the same as with no key at all.
  for (const [name, headers] of [["no key on A anonymous route", {}], ["B key on A anonymous route", { apikey: B.key }]]) {
    const r = await fetch(`${p}/${sa}/anon`, { headers, signal: AbortSignal.timeout(3000) });
    const text = await r.text();
    const consumer = /X-Consumer-Username: (.*)/i.exec(text)?.[1]?.trim();
    const anonymous = /X-Anonymous-Consumer: true/i.test(text);
    s.facts.cases.push({ name, want: "200 as A's anonymous guest", got: `${r.status} consumer=${consumer} anonymous=${anonymous}` });
    expect(s, r.status === 200 && anonymous && consumer === "guest", `${name}: ${r.status}, consumer ${consumer}, anonymous ${anonymous}`);
    expect(s, !text.includes(ctx.env.B.id), `${name}: B's workspace id reached A's upstream`);
  }
  const cfg = await kongAdmin(ctx.pod, "/plugins?size=1000");
  const names = (cfg?.data ?? []).map((x) => x.name);
  s.facts.plugins = [...new Set(names)].sort();
  for (const required of ["gromesh-workspace", "gromesh-route-guard"]) expect(s, names.includes(required), `${required} not in Kong's plugins`);
  s.facts.canary = await httpStatus(`${ctx.pod.proxy}/.gromesh/guard/current`);
  done(s);
}

async function negatives() {
  const s = step("C3-negative", "Divergences never converge; stale, foreign and regressive reports are refused; v1 refused on a v2 cluster");
  const token = await nodeToken(ctx.pod);
  const status = (body) => fetch(`${cpUrl}/agent/v2/status`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.text() }));
  // v1 on a v2 cluster.
  const body = (epoch, revision, d) => ({ nodeId: ctx.pod.nodeId, epoch, appliedRevision: revision, appliedHash: d.config_hash, kongConfigHash: d.kong_config_hash, kongHealthy: true });
  const v1 = await fetchV1Snapshot();
  negative(s, "agent v1 snapshot on a v2 cluster", "409 delivery-protocol-v2", `${v1.status} ${v1.body.slice(0, 120)}`, v1.status === 409 && v1.body.includes("delivery-protocol-v2"));

  // A new revision of identical content, agent running: it converges with the same hash (reapply/rollback rule).
  const prev = await latestDeployment();
  const same = await ok("POST", "/api/v2/deployments", { session: ctx.session, body: { expectedRevision: prev.revision, reason: "v2flow: identical content, new revision" } });
  const conv = await waitFor("a new revision of identical content converges", async () => {
    const x = (await nodes()).find((y) => y.node_id === ctx.pod.nodeId);
    const z = await latestDeployment();
    return z.revision === same.revision && z.state === "converged" && x.evidence === "verified" ? { x, z } : null;
  }, { timeoutMs: 120_000, intervalMs: 2000 }).catch(async (e) => { s.failures.push(e.message); s.facts.sameRevisionDiag = await revisionDiag(); return null; });
  s.facts.sameHashNewRevision = conv ? { revision: conv.z.revision, configHash: conv.z.config_hash, previousHash: prev.config_hash, verifiedRevision: conv.x.verified_revision } : null;
  if (conv) expect(s, conv.z.config_hash === prev.config_hash, "a reapply of identical content changed the hash");

  // Below the verified revision: refused, never recorded.
  const verified = await latestDeployment();
  const lower = await status(body(verified.epoch, verified.revision - 1, prev));
  negative(s, "status below the verified revision", "409 revision-regression", `${lower.status} ${lower.body.slice(0, 120)}`, lower.status === 409 && lower.body.includes("revision-regression"));
  // Epoch 1 is the only one before the snapshots → releases migration (D5): an older epoch does not exist yet.
  s.facts.olderEpoch = verified.epoch > 1 ? "not exercised" : "not applicable: the instance is at epoch 1 (covered by the C4 integration tests)";

  // A revision only declared by status (agent paused, no probe evidence for it): never verified or converged.
  await docker(["pause", ctx.pod.agent]);
  const next = await ok("POST", "/api/v2/deployments", { session: ctx.session, body: { expectedRevision: verified.revision, reason: "v2flow: revision while the agent is paused" } });
  const dep = await latestDeployment();
  const declared = await status(body(dep.epoch, dep.revision, dep));
  s.facts.declaredStatus = declared.status;
  await sleep(20_000);
  const n = (await nodes()).find((x) => x.node_id === ctx.pod.nodeId);
  const d = await latestDeployment();
  negative(s, "a revision declared by status alone", "not verified/converged", `${n.evidence}/${d.state}/verified=${n.verified_revision}`, !(Number(n.verified_revision) >= dep.revision) && d.state !== "converged");
  await docker(["unpause", ctx.pod.agent]);
  const resumed = await waitFor("the resumed agent converges the declared revision", async () => {
    const x = (await nodes()).find((y) => y.node_id === ctx.pod.nodeId);
    const z = await latestDeployment();
    return x.evidence === "verified" && z.state === "converged" && z.revision === next.revision ? { x, z } : null;
  }, { timeoutMs: 120_000, intervalMs: 2000 }).catch(async (e) => { s.failures.push(e.message); s.facts.resumeDiag = await revisionDiag(); return null; });
  s.facts.resumed = resumed ? { revision: resumed.z.revision, verifiedRevision: resumed.x.verified_revision } : null;

  // Kong serving another config. Agent running: it posts the authorized config again; the node may stay verified only
  // while its last matching report is inside the contract's 60 s freshness window.
  // served: "down" only when Kong is gone (its status socket missing or refusing, and the proxy refusing); any other
  // failure of the measurement is "unknown" and never counts as containment.
  const served = async (z) => {
    const r = await kongSocket(ctx.pod, "status", "GET", "/status");
    if (r.status === 200) {
      try { return JSON.parse(r.body).configuration_hash === z.kong_config_hash ? "expected" : "other"; } catch { return "unknown"; }
    }
    const gone = r.status === 0 && /ECONNREFUSED|ENOENT/.test(r.body);
    return gone && (await httpStatus(`${ctx.pod.proxy}/`)) === "down" ? "down" : "unknown";
  };
  const sample = async (t0) => {
    const x = (await nodes()).find((y) => y.node_id === ctx.pod.nodeId);
    const z = await latestDeployment();
    return { ms: Date.now() - t0, evidence: x.evidence, revision: z.revision, state: z.state, served: await served(z) };
  };
  const other = JSON.stringify({ config: JSON.stringify({ _format_version: "3.0" }) });
  let t0 = Date.now();
  const injected = await kongSocket(ctx.pod, "admin", "POST", "/config", other);
  s.facts.injectedStatus = injected.status;
  const seen = [];
  for (let i = 0; i < 60; i++) {
    seen.push(await sample(t0));
    if (seen.length > 3 && seen.at(-1).served === "expected" && seen.at(-1).evidence === "verified") break;
    await sleep(1000);
  }
  s.facts.divergenceAgentRunning = seen;
  const repaired = seen.find((x) => x.served === "expected");
  s.facts.repairMs = repaired?.ms ?? null;
  const staleVerified = seen.filter((x) => x.served === "other" && x.evidence === "verified").map((x) => x.ms);
  s.facts.verifiedWhileOtherMaxMs = staleVerified.length ? Math.max(...staleVerified) : 0;
  negative(s, "verified while Kong serves another config (agent running)", "only inside the 60 s freshness window", `${s.facts.verifiedWhileOtherMaxMs} ms`, s.facts.verifiedWhileOtherMaxMs <= 60_000);
  expect(s, repaired, "the agent did not restore the authorized config");

  // Probe paused, agent running: statuses keep arriving and re-evaluate, but no probe report does. The node's evidence
  // must leave verified once its last report is older than the 60 s window (plus one probe round and one status).
  // A precondition, not a hope: without verified first, the expiry below would prove nothing.
  await waitFor("verified before the probe pauses", async () => (await sample(Date.now())).evidence === "verified", { timeoutMs: 90_000, intervalMs: 2000 });
  await docker(["pause", ctx.pod.probe]);
  t0 = Date.now();
  const probeSilent = [];
  let expiredMs = null;
  while (Date.now() - t0 < 120_000 && expiredMs === null) {
    const x = await sample(t0);
    probeSilent.push(x);
    if (x.evidence !== "verified") expiredMs = x.ms;
    else await sleep(2000);
  }
  expect(s, probeSilent[0]?.evidence === "verified", `the node was not verified when the probe paused (${probeSilent[0]?.evidence})`);
  s.facts.probePaused = probeSilent;
  s.facts.probePausedEvidenceExpiredMs = expiredMs;
  negative(s, "verified while the probe is silent (agent running)", "leaves verified within 60 s + one probe round + one status", expiredMs === null ? "still verified at 120 s" : `${expiredMs} ms`, expiredMs !== null && expiredMs <= 60_000 + 30_000);
  await docker(["unpause", ctx.pod.probe]);
  const probeBack = await waitFor("the resumed probe re-verifies", async () => { const x = await sample(t0); return x.served === "expected" && x.evidence === "verified" ? x : null; }, { timeoutMs: 180_000, intervalMs: 2000 }).catch((e) => { s.failures.push(e.message); return null; });
  s.facts.probeRecoveredMs = probeBack?.ms ?? null;

  // Agent paused: nobody repairs and no report reaches the control plane. The CP must not declare anything new, must
  // open communication-failure for the silent pod, and the probe alone must contain Kong (guard-missing → stopped).
  await waitFor("verified again", async () => (await sample(Date.now())).evidence === "verified", { timeoutMs: 90_000, intervalMs: 2000 });
  const before = await latestDeployment();
  await docker(["pause", ctx.pod.agent]);
  t0 = Date.now();
  await kongSocket(ctx.pod, "admin", "POST", "/config", other);
  const during = await ok("POST", "/api/v2/deployments", { session: ctx.session, body: { expectedRevision: before.revision, reason: "v2flow: revision while the node is silent" } });
  const paused = [];
  let pendencyMs = null, containedMs = null, downInARow = 0;
  while (Date.now() - t0 < 150_000 && (pendencyMs === null || containedMs === null)) {
    const x = await sample(t0);
    const iso = (await req("GET", `/api/v2/clusters/${ctx.cluster.id}/isolation`, { session: ctx.session })).body;
    const pend = iso?.pendencies?.find((p) => p.kind === "communication-failure" && (p.podUid === ctx.pod.podUid || p.podUid === null));
    if (pend && pendencyMs === null) pendencyMs = x.ms;
    // Contained: two consecutive samples with Kong gone (a single failed measurement proves nothing).
    downInARow = x.served === "down" ? downInARow + 1 : 0;
    if (downInARow >= 2 && containedMs === null) containedMs = x.ms;
    paused.push({ ...x, pendency: pend?.kind ?? null });
    await sleep(3000);
  }
  s.facts.divergenceAgentPaused = paused;
  s.facts.pausedCommunicationFailureMs = pendencyMs;
  s.facts.pausedKongContainedMs = containedMs;
  const after = await latestDeployment();
  const silentNode = (await nodes()).find((y) => y.node_id === ctx.pod.nodeId);
  s.facts.revisionWhileSilent = { revision: during.revision, state: after.state, verifiedRevision: silentNode.verified_revision };
  negative(s, "a revision recorded while the node is silent and Kong serves another config", "not converged, never verified on the node",
    `${after.revision}/${after.state}/verified=${silentNode.verified_revision}`, after.revision === during.revision && after.state !== "converged" && !(Number(silentNode.verified_revision) >= during.revision));
  negative(s, "silent node (agent paused)", "communication-failure opened by the control plane", pendencyMs === null ? "none" : `${pendencyMs} ms`, pendencyMs !== null);
  negative(s, "Kong serving a config other than applied.json, agent paused", "contained by the probe (Kong stopped)", containedMs === null ? "still serving" : `${containedMs} ms`, containedMs !== null);
  // Recorded, not asserted: cluster_nodes.evidence is recomputed only by evaluate(); with no status nothing recomputes it.
  report.findings.push({ id: "D-3", what: "cluster_nodes.evidence stays 'verified' while the node is silent", observed: paused.filter((x) => x.evidence === "verified").length + " samples", impact: "history only (audit); the current reading is DeliveryService.clusterView (PR #194); the isolation pendency and the probe's containment cover the silence" });
  await docker(["unpause", ctx.pod.agent]);
  const back = await waitFor("the resumed agent restores and re-verifies", async () => { const x = await sample(t0); return x.served === "expected" && x.evidence === "verified" ? x : null; }, { timeoutMs: 120_000, intervalMs: 2000 }).catch((e) => { s.failures.push(e.message); return null; });
  s.facts.recoveredMs = back?.ms ?? null;
  done(s);
}

async function v1Regression() {
  const s = step("C4-v1", "A v1 cluster beside it: v1 publish, snapshot and agent v1 as before; the v2 stack never touches it");
  const env = await ok("POST", "/api/v1/environments", { session: ctx.session, body: { name: "v2flow-legacy" } });
  const svc = await ok("POST", `/api/v1/environments/${env.id}/services`, { session: ctx.session, body: { name: "svc", protocol: "http", host: "echo", port: 80 } });
  await ok("POST", `/api/v1/environments/${env.id}/routes`, { session: ctx.session, body: { name: "legacy", serviceId: svc.id, paths: ["/legacy"], stripPath: false } });
  const cluster = await ok("POST", `/api/v1/environments/${env.id}/clusters`, { session: ctx.session, body: { name: "v2flow-legacy-dp" } });
  secrets.add(cluster.registrationToken);
  const snap = await ok("POST", `/api/v1/environments/${env.id}/snapshots`, { session: ctx.session, body: { message: "v2flow legacy" } });
  s.facts.snapshot = { version: snap.version, hash: snap.hash };
  const pod = await v1Pod("legacy", { registrationToken: cluster.registrationToken });
  const served = await waitFor("v1 route served", async () => (await httpStatus(`${pod.proxy}/legacy`)) === 200, { timeoutMs: 120_000, intervalMs: 1000 }).catch(() => false);
  expect(s, served, "the v1 pod does not serve its snapshot");
  const proto = (await sql(`select delivery_protocol from clusters where id = '${cluster.id}'`))[0].delivery_protocol;
  s.facts.protocol = proto;
  expect(s, proto === "v1", `the legacy cluster's protocol is ${proto}`);
  const node = (await sql(`select applied_hash from cluster_nodes where cluster_id = '${cluster.id}'`).catch(() => [{}]))[0];
  s.facts.node = node;
  const ws = await httpStatus(`${pod.proxy}/${(await sql(`select slug from workspaces where id = '${ctx.env.A.id}'`))[0].slug}/key`, { apikey: ctx.env.A.key });
  negative(s, "a v2 route on the v1 pod", "404 (v2 never reaches a v1 cluster)", ws, ws === 404);
  done(s);
}

async function main() {
  let failed = null;
  try {
    for (const fn of [setup, modeOff, podUp, deliver, traffic, negatives, v1Regression]) {
      try { await fn(); } catch (error) {
        const s = report.steps.at(-1);
        if (s && s.result === "pending") { s.result = "fail"; s.failures.push(redact(error.stack ?? String(error)).slice(0, 3000)); }
        failed = error;
        break;
      }
    }
  } finally {
    if (failed && ctx.pod) {
      // What the failing state looked like, before anything is removed.
      report.diagnosis = {
        nodes: await nodes().catch((e) => String(e)),
        deployment: await latestDeployment().catch((e) => String(e)),
        kongStatus: await kongStatus(ctx.pod),
        snapshotDir: (await docker(["run", "--rm", "-v", `${ctx.pod.volumes.snapshot}:/v:ro`, NODE_IMAGE, "ls", "-la", "/v"], { allowFail: true })).stdout,
        handoff: (await docker(["run", "--rm", "-v", `${ctx.pod.volumes.handoff}:/v:ro`, NODE_IMAGE, "ls", "-la", "/v"], { allowFail: true })).stdout,
        kongAdminSockets: (await docker(["run", "--rm", "-v", `${ctx.pod.volumes.kongAdmin}:/v:ro`, NODE_IMAGE, "ls", "-la", "/v"], { allowFail: true })).stdout,
        manualApply: await (async () => {
          // The deployment as the agent receives it, posted to Kong by hand: Kong's own answer.
          const token = await nodeToken(ctx.pod).catch(() => null);
          if (!token) return null;
          const r = await fetch(`${cpUrl}/agent/v2/deployments/current`, { headers: { authorization: `Bearer ${token}` } });
          const text = await r.text();
          if (r.status !== 200) return { fetch: r.status, body: text.slice(0, 500) };
          const config = JSON.parse(text).config;
          const body = JSON.stringify({ config: typeof config === "string" ? config : JSON.stringify(config) });
          const k = await kongSocket(ctx.pod, "admin", "POST", "/config?check_hash=1", body);
          return { fetch: r.status, configType: typeof config, kong: { status: k.status, body: k.body.slice(0, 1500) } };
        })().catch((e) => String(e)),
      };
    }
    if (ctx.pod) for (const c of [ctx.pod.agent, ctx.pod.probe, ctx.pod.kong]) {
      const l = await docker(["logs", "--tail", "80", c], { allowFail: true });
      report[`logs:${c.replace(PREFIX, "")}`] = redact(`${l.stdout}${l.stderr}`).split("\n").slice(-80);
    }
    report.finishedAt = new Date().toISOString();
    save();
    await (tearing ?? teardown());
  }
  log(`results: ${join(out, "results.json")}`);
  const failures = report.steps.filter((s) => s.result !== "pass");
  if (failed || failures.length) { console.error(`FAILED: ${failures.map((s) => s.id).join(", ")}`); process.exit(1); }
  console.log("v2 flow: every step passed");
}

await main();
