#!/usr/bin/env node
// Hotfix F-1 regression against the real compose Kong, Vector and ClickHouse: a route of the gateway aimed at the
// collector forges events for another environment. Only the gateway's own http-log (with the cluster's token) may
// write. Requires the observability profile and a stopped agent; restores the prior opaque gateway config.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { NODE_IMAGE, pullImages } from "./docker-images.mjs";
import { dockerProcess, processFailure } from "../scripts/private-process.mjs";
import { assertStack } from "../scripts/stack-guard.mjs";

await assertStack("acceptance");

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const composeFile = fileURLToPath(new URL("../deploy/compose/docker-compose.yml", import.meta.url));
const env = { ...process.env, POSTGRES_PORT: process.env.POSTGRES_PORT ?? "55433" };
const secrets = new Set();
const run = (args, extraEnv = {}) => {
  const command = dockerProcess(args, {...env, ...extraEnv});
  return exec("docker", command.args, { cwd: root, env: command.env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
    .catch(error => { throw processFailure(error, command.env, [...secrets]); });
};
const compose = (...args) => run(["compose", ...(env.COMPOSE_FILE ? [] : ["-f", composeFile]), "--profile", "observability", ...args]);
const proxy = process.env.KONG_PROXY_URL ?? "http://127.0.0.1:8000";
const clickhouse = process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
const check = (ok, message) => assert.ok(ok, message);
const token = process.env.GROMESH_COLLECTOR_TOKEN ?? "gromesh-dev-collector-token-not-a-secret";
const VECTOR_IMAGE = "timberio/vector:0.57.0-alpine@sha256:19e3526faf4d4b1ed0c28a0d68d4cc3a1e13e437099986a5b7a768707907497c";

// Beside Kong with its kong-admin volume: the Admin API listens only on a Unix socket (contract: agent-protocol).
async function admin(id, method, body) {
  const child = execFile("docker", ["run", "--rm", "-i", "--volumes-from", id, "--user", "1001:1001",
    NODE_IMAGE, "node", "--input-type=module", "-e", `
      import { readFileSync } from 'node:fs';
      import { request } from 'node:http';
      const body = readFileSync(0, 'utf8');
      const response = await new Promise((resolve, reject) => {
        const req = request({ socketPath: '/kong/admin/admin.sock', path: '/config', method: process.argv[1],
          headers: {'content-type': 'application/json'}, timeout: 10000 }, (res) => {
          let text = '';
          res.setEncoding('utf8').on('data', (chunk) => { text += chunk; }).on('end', () => resolve({ status: res.statusCode, text }));
        });
        req.on('timeout', () => req.destroy(new Error('timeout'))).on('error', reject).end(body || undefined);
      });
      if (response.status < 200 || response.status > 299) throw new Error('Admin API HTTP ' + response.status);
      console.log(JSON.stringify(process.argv[1] === 'GET' ? JSON.parse(response.text) : {status: response.status}));
    `, method], { cwd: root, env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  child.stdin.end(body === undefined ? "" : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", () => reject(new Error("Admin helper failed")));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error("Admin helper failed"));
      try { resolve(JSON.parse(output)); } catch { reject(new Error("Invalid admin helper result")); }
    });
  });
}

async function rows(environmentId) {
  const user = process.env.CLICKHOUSE_USER ?? "gromesh";
  const password = process.env.CLICKHOUSE_PASSWORD ?? "gromesh-dev-observability";
  const response = await request(clickhouse, {
    method: "POST", headers: { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` },
    body: `SELECT path FROM gromesh.requests WHERE environment_id = '${environmentId}' FORMAT JSONEachRow`,
  });
  check(response.ok, `ClickHouse query failed (HTTP ${response.status})`);
  return (await response.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line).path);
}

async function main() {
  await pullImages([NODE_IMAGE]);
  const { stdout: agents } = await compose("ps", "--status", "running", "-q", "agent");
  check(agents.trim() === "", "Stop the compose agent before running: it would overwrite the test config");
  const id = (await compose("ps", "-q", "kong")).stdout.trim();
  const vector = (await compose("ps", "-q", "vector")).stdout.trim();
  check(id && vector, "The compose Kong and the observability collector must be running");
  const { stdout: ip } = await run(["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", vector]);
  const collectorAddress = ip.trim().split(" ")[0];
  const own = randomUUID();
  const victim = randomUUID();
  // A second collector pinned to `own`, as the chart deploys it, in the middle of a token rotation: its new token,
  // and the gateway's token as the previous one. A VALID token must still not write another environment.
  const { stdout: network } = await run(["inspect", "-f", "{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}", vector]);
  const pinnedName = `gromesh-pinned-collector-${own.slice(0, 8)}`;
  const rotated = randomBytes(36).toString("base64url");
  const otherCluster = randomBytes(36).toString("base64url");
  secrets.add(rotated); secrets.add(otherCluster);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(`::add-mask::${rotated}`);
    console.log(`::add-mask::${otherCluster}`);
  }
  const startPinned = async (previous) => {
    await run(["rm", "-f", pinnedName]).catch(() => {});
    await run(["run", "-d", "--name", pinnedName, "--network", network.trim().split(" ")[0], "--user", "65534:65534",
      "--tmpfs", "/var/lib/vector:uid=65534,gid=65534,mode=0700", "--entrypoint", "sh",
      "-e", "GROMESH_CLUSTER_ID=00000000-0000-4000-8000-00000000c0c0", "-e", `GROMESH_ENVIRONMENT_ID=${own}`,
      "-e", "GROMESH_COLLECTOR_TOKEN", "-e", "GROMESH_COLLECTOR_TOKEN_PREVIOUS",
      "-e", "CLICKHOUSE_PASSWORD",
      "-v", `${root}deploy/observability/vector:/etc/vector:ro`, VECTOR_IMAGE, "/etc/vector/entrypoint.sh"], {
        GROMESH_COLLECTOR_TOKEN: rotated, GROMESH_COLLECTOR_TOKEN_PREVIOUS: previous,
        CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_WRITER_PASSWORD,
      });
  };
  await startPinned(token);

  await exec("pnpm", ["--filter", "@gromesh/compiler", "build"], { cwd: root, env, timeout: 60_000 });
  const { compile, platformPlugins } = await import("../packages/compiler/dist/index.js");
  const base = `/collector-auth-${own}`;
  const echo = { id: randomUUID(), name: "echo", protocol: "http", host: "echo", port: 80 };
  // The CP refuses the collector's name (forbidden destinations) but cannot know its address: this is that bypass.
  const collector = { id: randomUUID(), name: "collector", protocol: "http", host: collectorAddress, port: 8080, path: "/kong" };
  // By container name: the restarted collector may come back on another address.
  const pinned = { id: randomUUID(), name: "pinned", protocol: "http", host: pinnedName, port: 8080, path: "/kong" };
  const config = compile({
    services: [echo, collector, pinned],
    routes: [
      { id: randomUUID(), name: "ok", serviceId: echo.id, paths: [`${base}/ok`] },
      { id: randomUUID(), name: "forge", serviceId: collector.id, paths: [`${base}/forge`], stripPath: true },
      { id: randomUUID(), name: "forge-pinned", serviceId: pinned.id, paths: [`${base}/forge-pinned`], stripPath: true },
    ],
    consumers: [], keyAuthCredentials: [], plugins: [],
  }, { platformPlugins: platformPlugins({ environmentId: own, httpLogEndpoint: "http://gromesh-collector:8080/kong" }) });

  const prior = await admin(id, "GET");
  try {
    await admin(id, "POST", config);
    for (let attempt = 0; ; attempt++) {
      const response = await request(`${proxy}${base}/ok`);
      await response.arrayBuffer();
      if (response.status === 200) break;
      check(attempt < 50, "Gateway workers must load the test routes");
      await sleep(100);
    }
    const forged = (path, environmentId = own) => JSON.stringify([{
      environment_id: environmentId, started_at: Date.now(), client_ip: "203.0.113.7",
      request: { uri: `/forged${path}`, method: "GET", size: 1 }, response: { status: 200, size: 1 },
      latencies: { kong: 1, proxy: 1, request: 2 },
    }]);
    const statuses = [];
    for (const [path, headers] of [["/no-token", {}], ["/wrong-token", { "x-gromesh-collector-token": "guess" }]]) {
      const response = await request(`${proxy}${base}/forge`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: forged(path) });
      await response.arrayBuffer();
      statuses.push(response.status);
    }
    const toPinned = (path, environmentId, credential) => request(`${proxy}${base}/forge-pinned`, {
      method: "POST", headers: { "content-type": "application/json", "x-gromesh-collector-token": credential }, body: forged(path, environmentId),
    }).then(async (response) => { await response.arrayBuffer(); return response.status; }, () => null);
    const accepted = async (path, environmentId, credential) => {
      for (let attempt = 0; ; attempt++) {
        const status = await toPinned(path, environmentId, credential);
        if (status === 200) return;
        check(attempt < 40, `The pinned collector must accept ${path} (HTTP ${status ?? "no answer"})`);
        await sleep(500);
      }
    };
    // Through the proxy to the pinned collector: another environment is dropped, its own kept, with either token
    // of the rotation; another cluster's token is refused.
    await accepted("/valid-token-other-environment", victim, token);
    await accepted("/valid-token-own-environment", own, token);
    await accepted("/rotated-token-own-environment", own, rotated);
    const crossCluster = await toPinned("/other-cluster-token", own, otherCluster);
    // The rotation ends: the previous token is removed and refused from then on.
    await startPinned("");
    await accepted("/after-rotation-new-token", own, rotated);
    const retired = await toPinned("/after-rotation-old-token", own, token);
    // The gateway's own http-log (token from its environment) must still reach ClickHouse.
    let legit = [];
    const expected = [`${base}/ok`, "/forged/valid-token-own-environment", "/forged/rotated-token-own-environment", "/forged/after-rotation-new-token"];
    for (let attempt = 0; attempt < 60 && !expected.every((path) => legit.includes(path)); attempt++) {
      await sleep(500);
      legit = await rows(own);
    }
    check(legit.includes(`${base}/ok`), "The gateway's own analytics must still be written (token resolved from its environment)");
    check(expected.every((path) => legit.includes(path)), `The pinned collector must write its own environment's events (got ${legit.join(", ")})`);
    check(crossCluster === 401 && !legit.includes("/forged/other-cluster-token"), `Another cluster's token must be refused (HTTP ${crossCluster})`);
    check(retired === 401 && !legit.includes("/forged/after-rotation-old-token"), `The previous token must be refused after the rotation (HTTP ${retired})`);
    check(!legit.some((path) => ["/forged/no-token", "/forged/wrong-token"].includes(path)), `A forged event without a valid token reached ClickHouse through the proxy (HTTP ${statuses.join("/")})`);
    check((await rows(victim)).length === 0, "A valid token wrote another environment's analytics");
    check(statuses.every((status) => status === 401), `Forged events must be refused with 401, got HTTP ${statuses.join("/")}`);
    // Migration (G-4): a snapshot compiled before the hotfix has no token header, so its analytics stop at the
    // collector. The data plane is upgraded only after every environment is republished by the new control plane.
    const legacy = structuredClone(config);
    for (const plugin of legacy.plugins) if (plugin.name === "http-log") delete plugin.config.headers;
    await admin(id, "POST", legacy);
    const legacyPath = `${base}/ok?legacy=${randomUUID()}`;
    for (let attempt = 0; ; attempt++) {
      const response = await request(`${proxy}${legacyPath}`);
      await response.arrayBuffer();
      if (response.status === 200) break;
      check(attempt < 50, "Gateway workers must load the legacy config");
      await sleep(100);
    }
    const before = (await rows(own)).filter((path) => path === `${base}/ok`).length;
    await sleep(6000);
    const after = (await rows(own)).filter((path) => path === `${base}/ok`).length;
    check(after === before, "A snapshot without the token header must not write analytics (republish before upgrading the data plane)");
    console.log(`Collector refused events forged through the proxy (HTTP ${statuses.join("/")}); a valid token could not write ` +
      "another environment; another cluster's token, the retired token and a pre-hotfix snapshot were refused; the gateway's own analytics arrived");
  } finally {
    await admin(id, "POST", prior);
    await run(["rm", "-f", pinnedName]).catch(() => {});
  }
}

await main();
