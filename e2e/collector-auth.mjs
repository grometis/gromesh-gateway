#!/usr/bin/env node
// Hotfix F-1 regression against the real compose Kong, Vector and ClickHouse: a route of the gateway aimed at the
// collector forges events for another environment. Only the gateway's own http-log (with the cluster's token) may
// write. Requires the observability profile and a stopped agent; restores the prior opaque gateway config.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { NODE_IMAGE, pullImages } from "./docker-images.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const composeFile = fileURLToPath(new URL("../deploy/compose/docker-compose.yml", import.meta.url));
const env = { ...process.env, POSTGRES_PORT: process.env.POSTGRES_PORT ?? "55433" };
const run = (args) => exec("docker", args, { cwd: root, env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
const compose = (...args) => run(["compose", ...(env.COMPOSE_FILE ? [] : ["-f", composeFile]), "--profile", "observability", ...args]);
const proxy = process.env.KONG_PROXY_URL ?? "http://127.0.0.1:8000";
const clickhouse = process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
const check = (ok, message) => assert.ok(ok, message);

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

  await exec("pnpm", ["--filter", "@gromesh/compiler", "build"], { cwd: root, env, timeout: 60_000 });
  const { compile, platformPlugins } = await import("../packages/compiler/dist/index.js");
  const own = randomUUID();
  const victim = randomUUID();
  const base = `/collector-auth-${own}`;
  const echo = { id: randomUUID(), name: "echo", protocol: "http", host: "echo", port: 80 };
  // The CP refuses the collector's name (forbidden destinations) but cannot know its address: this is that bypass.
  const collector = { id: randomUUID(), name: "collector", protocol: "http", host: collectorAddress, port: 8080, path: "/kong" };
  const config = compile({
    services: [echo, collector],
    routes: [
      { id: randomUUID(), name: "ok", serviceId: echo.id, paths: [`${base}/ok`] },
      { id: randomUUID(), name: "forge", serviceId: collector.id, paths: [`${base}/forge`], stripPath: true },
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
    const forged = (path) => JSON.stringify([{
      environment_id: victim, started_at: Date.now(), client_ip: "203.0.113.7",
      request: { uri: `/forged${path}`, method: "GET", size: 1 }, response: { status: 200, size: 1 },
      latencies: { kong: 1, proxy: 1, request: 2 },
    }]);
    const statuses = [];
    for (const [path, headers] of [["/no-token", {}], ["/wrong-token", { "x-gromesh-collector-token": "guess" }]]) {
      const response = await request(`${proxy}${base}/forge`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: forged(path) });
      await response.arrayBuffer();
      statuses.push(response.status);
    }
    // The gateway's own http-log (token from its environment) must still reach ClickHouse.
    let legit = [];
    for (let attempt = 0; attempt < 60 && !legit.includes(`${base}/ok`); attempt++) {
      await sleep(500);
      legit = await rows(own);
    }
    const stolen = await rows(victim);
    check(legit.includes(`${base}/ok`), "The gateway's own analytics must still be written (token resolved from its environment)");
    check(stolen.length === 0, `A forged event reached ClickHouse for another environment through the proxy (HTTP ${statuses.join("/")})`);
    check(statuses.every((status) => status === 401), `Forged events must be refused with 401, got HTTP ${statuses.join("/")}`);
    console.log(`Collector refused events forged through the proxy (HTTP ${statuses.join("/")}); the gateway's own analytics arrived`);
  } finally {
    await admin(id, "POST", prior);
  }
}

await main();
