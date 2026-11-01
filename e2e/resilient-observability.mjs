#!/usr/bin/env node
// Requires the running compose observability profile. Uses compiler output and restores the opaque prior config.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { NODE_IMAGE, pullImages } from "./docker-images.mjs";
import { assertStack } from "../scripts/stack-guard.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const composeFile = fileURLToPath(new URL("../deploy/compose/docker-compose.yml", import.meta.url));
const env = { ...process.env, POSTGRES_PORT: process.env.POSTGRES_PORT ?? "55433" };
const run = (args) => exec("docker", args, { cwd: root, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
const compose = (...args) => run(["compose", ...(env.COMPOSE_FILE ? [] : ["-f", composeFile]), "--profile", "observability", ...args]);
const proxy = process.env.KONG_PROXY_URL ?? "http://127.0.0.1:8000";
const clickhouse = process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(5000) });

// The Admin API listens only on a Unix socket in the kong-admin volume (contract: agent-protocol).
// No config, credentials or raw subprocess output is printed.
async function admin(method, body) {
  const { stdout: id } = await compose("ps", "-q", "kong");
  const child = execFile("docker", ["run", "--rm", "-i", "--volumes-from", id.trim(), "--user", "1001:1001",
    NODE_IMAGE, "node", "--input-type=module", "-e", `
      import { readFileSync } from 'node:fs';
      import { request } from 'node:http';
      const body = readFileSync(0, 'utf8');
      // Kong's Admin API listens only on a Unix socket (contract: agent-protocol); fetch cannot dial it.
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
  child.stdin.end(body ? JSON.stringify(body) : "");
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`Admin helper exited ${code}`)));
  });
}

/**
 * Probes the collector's http-log endpoint (/kong) with the compose healthcheck's own request until it accepts, so a
 * restart from a previous scenario is never measured as this one's loss. The probe runs directly: Docker's health
 * status can stay stale after a `compose restart`.
 */
async function collectorReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await compose("exec", "-T", "vector", "sh", "-c",
        'wget -q -O /dev/null --header "X-Gromesh-Collector-Token: $GROMESH_COLLECTOR_TOKEN" --post-data=[] http://127.0.0.1:8080/kong');
      return;
    } catch {
      assert.ok(Date.now() < deadline, `Collector must accept on its http-log endpoint within ${timeoutMs / 1000} s`);
      await sleep(500);
    }
  }
}

async function main() {
  await assertStack("acceptance");
  // The timeouts below cover only the runs: the helper image is pulled first, with retries.
  await pullImages([NODE_IMAGE]);
  await exec("pnpm", ["--filter", "@gromesh/compiler", "build"], { cwd: root, env, timeout: 60_000 });
  const { compile, platformPlugins } = await import("../packages/compiler/dist/index.js");
  const { stdout: agents } = await compose("ps", "--status", "running", "-q", "agent");
  assert.equal(agents.trim(), "", "Stop the compose agent before running: it would overwrite the test snapshot");
  const environmentId = randomUUID();
  const serviceId = randomUUID();
  const base = `/resilience-${environmentId}`;
  const config = compile({
    services: [{ id: serviceId, name: "resilience", protocol: "http", host: "echo", port: 80 }],
    routes: [{ id: randomUUID(), name: "resilience", serviceId, paths: [base] }],
    consumers: [], keyAuthCredentials: [], plugins: [],
  }, { platformPlugins: platformPlugins({ environmentId, httpLogEndpoint: "http://gromesh-collector:8080/kong" }) });
  const headers = { authorization: `Basic ${Buffer.from(`${process.env.CLICKHOUSE_USER ?? "gromesh"}:${process.env.CLICKHOUSE_PASSWORD ?? "gromesh-dev-observability"}`).toString("base64")}` };
  const received = async () => {
    const response = await request(clickhouse, { method: "POST", headers,
      body: `SELECT DISTINCT path FROM gromesh.requests WHERE environment_id = '${environmentId}' FORMAT JSONEachRow` });
    assert.equal(response.status, 200, "ClickHouse query must succeed");
    const text = (await response.text()).trim();
    return new Set(text ? text.split("\n").map((line) => JSON.parse(line).path) : []);
  };
  const coldDns = process.argv.includes("--cold-dns");
  const prior = await admin("GET");
  let active = true;
  let traffic;
  const sent = [];
  const errors = [];
  let started;
  let collectorStopped = false;
  try {
    await collectorReady();
    if (coldDns) {
      await compose("stop", "vector");
      collectorStopped = true;
      await compose("up", "-d", "--force-recreate", "--no-deps", "kong");
      for (let i = 0; ; i++) {
        try {
          const response = await request(process.env.KONG_STATUS_URL ?? "http://127.0.0.1:8100/status/ready");
          await response.arrayBuffer();
          if (response.ok) break;
        } catch { /* Wait for the recreated gateway's status listener. */ }
        assert.ok(i < 60, "Gateway must become ready");
        await sleep(500);
      }
    }
    await admin("POST", config);
    // A stale worker's 404 must not enter the measured traffic window.
    for (let i = 0; ; i++) {
      const response = await request(`${proxy}${base}/ready`);
      await response.arrayBuffer();
      if (response.status === 200) break;
      assert.ok(i < 50, "Workers must load the test route");
      await sleep(100);
    }
    started = performance.now();
    traffic = (async () => {
      let sequence = 0;
      while (active) {
        const tick = performance.now();
        const path = `${base}/${sequence++}`;
        try {
          const response = await request(proxy + path);
          await response.arrayBuffer();
          if (response.status === 200) sent.push(path);
          else errors.push(`HTTP ${response.status}`);
        } catch { errors.push("Traffic request failed"); }
        await sleep(Math.max(0, 100 - (performance.now() - tick)));
      }
    })();
    if (coldDns) {
      // Force a real negative lookup before the collector exists; a warm restart alone cannot catch this regression.
      await sleep(5000);
    } else {
      // Prove this test's events arrive before injecting the failure.
      for (let i = 0; (await received()).size < 10; i++) {
        assert.ok(i < 30, "Collector must receive warm-up traffic");
        await sleep(1000);
      }
    }
    const restartAt = performance.now();
    // Restart retains the collector identity/env and exercises the existing process under continuous traffic.
    await compose("restart", "--no-deps", "vector");
    collectorStopped = false;
    let recoverySeconds;
    if (coldDns) {
      for (let i = 0; (await received()).size === 0; i++) {
        assert.ok(i < 30, "Cold NXDOMAIN recovery must take at most 30 seconds");
        await sleep(1000);
      }
      recoverySeconds = (performance.now() - restartAt) / 1000;
      assert.ok(recoverySeconds <= 30, "Cold NXDOMAIN recovery must take at most 30 seconds");
    }
    await sleep(30_000);
    active = false;
    await traffic;
    const durationSeconds = (performance.now() - started) / 1000;
    let rows;
    for (let i = 0; i <= 90; i++) {
      rows = await received();
      if (sent.every((path) => rows.has(path))) break;
      if (i < 90) await sleep(1000);
    }
    const lost = sent.filter((path) => !rows.has(path)).length;
    const lostSeconds = lost / (sent.length / durationSeconds);
    console.log(JSON.stringify({ scenario: coldDns ? "cold-nxdomain" : "restart", recoverySeconds, sent: sent.length, received: sent.length - lost, lost,
      lostSeconds, durationSeconds, restartAtSeconds: (restartAt - started) / 1000 }));
    assert.deepEqual(errors, [], "Continuous gateway traffic must remain successful");
    assert.ok(sent.length >= 300, "At least 30 seconds of traffic at approximately 10 requests/s is required");
    assert.ok(lostSeconds <= 10, `Collector restart lost ${lostSeconds.toFixed(3)} seconds of events (maximum 10)`);
  } finally {
    active = false;
    await traffic;
    if (collectorStopped) await compose("restart", "--no-deps", "vector");
    await admin("POST", prior);
    // The next scenario (or test file) starts from a ready collector.
    await collectorReady();
  }
}

main().catch((error) => {
  // Child-process errors can carry configuration or secrets (subprocess output, env): outside CI only deliberate
  // assertions are shown; in CI the message and stack are shown without the subprocess streams.
  if (error instanceof assert.AssertionError) console.error(error.message);
  else if (process.env.CI) console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  else console.error("Resilience acceptance failed; check compose service health and connectivity");
  process.exitCode = 1;
});
