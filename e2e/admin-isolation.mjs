#!/usr/bin/env node
// Hotfix C-1 regression against the real compose Kong: services and targets aimed at the gateway itself
// (127.0.0.1:8001, localhost, [::1], a name resolving to 127.0.0.1, the container's own address) must never reach
// the Admin or status API through the proxy. Requires a stopped agent; restores the prior opaque gateway config.
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
const compose = (...args) => run(["compose", ...(env.COMPOSE_FILE ? [] : ["-f", composeFile]), ...args]);
const proxy = process.env.KONG_PROXY_URL ?? "http://127.0.0.1:8000";
const status = process.env.KONG_METRICS_URL ?? "http://127.0.0.1:8100";
const request = (url) => fetch(url, { signal: AbortSignal.timeout(5000) });
const check = (ok, message) => assert.ok(ok, message);
// Isolation failures are collected, not thrown, so the negative control (admin-isolation.spec.ts) sees all of them.
const failures = [];
const expectIsolated = (ok, message) => { if (!ok) failures.push(message); };

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

// Admin API and status API bodies; none may come back through the proxy.
const leaked = (text) => /"(tagline|lua_version|configuration|node_id|plugins_available|server|memory|database)"\s*:/.test(text);

async function main() {
  await pullImages([NODE_IMAGE]);
  const { stdout: agents } = await compose("ps", "--status", "running", "-q", "agent");
  check(agents.trim() === "", "Stop the compose agent before running: it would overwrite the test config");
  const id = (await compose("ps", "-q", "kong")).stdout.trim();
  check(id, "The compose Kong must be running");

  // An unclean exit leaves both sockets in the volume and nginx's bind() would fail; the gateway removes them at start.
  await compose("kill", "-s", "KILL", "kong");
  const { stdout: orphans } = await run(["run", "--rm", "--volumes-from", id, "--user", "1001:1001", NODE_IMAGE, "node", "-e",
    "const fs = require('node:fs'); console.log(['admin', 'status'].filter((n) => fs.statSync(`/kong/admin/${n}.sock`).isSocket()).length)"]);
  check(orphans.trim() === "2", "The killed gateway must leave its sockets behind");
  await compose("start", "kong");
  for (let attempt = 0; ; attempt++) {
    const { stdout: health } = await run(["inspect", "-f", "{{.State.Health.Status}}", id]);
    if (health.trim() === "healthy") break;
    check(health.trim() !== "unhealthy" && attempt < 60, "The gateway must come back after an unclean exit");
    await sleep(1000);
  }
  const { stdout: ip } = await run(["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", id]);
  const ownAddress = ip.trim().split(" ")[0];
  check(/^\d+\.\d+\.\d+\.\d+$/.test(ownAddress), "Kong container address not found");

  // No TCP Admin API, Admin GUI or full status listener: only the proxy (8000/8443) and metrics (8100).
  const { stdout: tcp } = await compose("exec", "-T", "kong", "cat", "/proc/net/tcp", "/proc/net/tcp6");
  // 0B00007F is 127.0.0.11, Docker's embedded DNS resolver in every container's network namespace.
  const listening = new Set(tcp.split("\n").map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols[3] === "0A" && !cols[1].startsWith("0B00007F:")).map((cols) => parseInt(cols[1].split(":").pop(), 16)));
  const ports = [...listening].sort((a, b) => a - b).join(",");
  expectIsolated(ports === "8000,8100,8443", `Unexpected TCP listeners in the gateway: ${ports}`);

  await exec("pnpm", ["--filter", "@gromesh/compiler", "build"], { cwd: root, env, timeout: 60_000 });
  const { compile } = await import("../packages/compiler/dist/index.js");
  const base = `/admin-isolation-${randomUUID()}`;
  const destinations = [
    ["loopback", "127.0.0.1", 8001], ["localhost", "localhost", 8001], ["ipv6-loopback", "::1", 8001],
    ["loopback-name", "loopback-alias.test", 8001], ["own-address", ownAddress, 8001],
    ["gui", "127.0.0.1", 8002], ["status-loopback", "127.0.0.1", 8100], ["status-own-address", ownAddress, 8100],
  ];
  const services = destinations.map(([name, host, port]) => ({ id: randomUUID(), name, protocol: "http", host, port }));
  const upstream = { id: randomUUID(), name: "admin-isolation.upstream" };
  services.push({ id: randomUUID(), name: "target-loopback", protocol: "http", host: upstream.name, port: 80 });
  const config = compile({
    services,
    routes: services.map((s) => ({ id: randomUUID(), name: s.name, serviceId: s.id, paths: [`${base}/${s.name}`], stripPath: true })),
    consumers: [], keyAuthCredentials: [], plugins: [],
    upstreams: [upstream], targets: [{ id: randomUUID(), upstreamId: upstream.id, target: "127.0.0.1:8001" }],
  });

  const prior = await admin(id, "GET");
  try {
    await admin(id, "POST", config);
    for (let attempt = 0; ; attempt++) {
      const response = await request(`${proxy}${base}/loopback`);
      await response.arrayBuffer();
      if (response.status !== 404) break;
      check(attempt < 50, "Gateway workers must load the isolation routes");
      await sleep(100);
    }
    const results = [];
    for (const service of services) {
      for (const path of ["", "/", "/services", "/config", "/status", "/status/ready", "/metrics", "/kconfig.js"]) {
        const response = await request(`${proxy}${base}/${service.name}${path}`);
        const text = await response.text();
        expectIsolated(!leaked(text), `${service.name}${path}: Admin/status API reached through the proxy (HTTP ${response.status})`);
        // /metrics and /status/ready exist on TCP 8100, but refuse requests coming from the gateway itself.
        expectIsolated(response.status !== 200, `${service.name}${path}: HTTP 200 through the proxy`);
        results.push(response.status);
      }
    }
    // Outside the container the metrics listener serves only /metrics and /status/ready.
    for (const [path, expected] of [["/metrics", 200], ["/status/ready", 200], ["/status", 404], ["/services", 404], ["/config", 404]]) {
      const response = await request(`${status}${path}`);
      await response.arrayBuffer();
      expectIsolated(response.status === expected, `TCP 8100${path}: HTTP ${response.status}, expected ${expected}`);
    }
    assert.ok(failures.length === 0, `${failures.length} isolation failures:\n${failures.slice(0, 20).join("\n")}`);
    console.log(`No Admin/status API through the proxy: ${services.length} destinations, ${results.length} requests ` +
      `(${[...new Set(results)].sort().join("/")}); TCP listeners 8000, 8443, 8100 (metrics and readiness only); recovered from orphan sockets`);
  } finally {
    await admin(id, "POST", prior);
  }
}

await main();
