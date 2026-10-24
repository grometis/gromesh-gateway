#!/usr/bin/env node
// Requires compose observability and a stopped agent; restores the prior opaque gateway config.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { NODE_IMAGE, pullImages, VECTOR_IMAGE } from "./docker-images.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const composeFile = fileURLToPath(new URL("../deploy/compose/docker-compose.yml", import.meta.url));
const env = { ...process.env, POSTGRES_PORT: "55433" };
const run = (args) => exec("docker", args, { cwd: root, env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
const compose = (...args) => run(["compose", ...(env.COMPOSE_FILE ? [] : ["-f", composeFile]), "--profile", "observability", ...args]);
const proxy = process.env.KONG_PROXY_URL ?? "http://127.0.0.1:8000";
const clickhouse = process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
const check = (ok, message) => assert.ok(ok, message);

// Execute inside Kong's network namespace (the collector is on the compose network). Never print responses/configs.
async function insideGateway(endpoint, method, body) {
  const { stdout: id } = await compose("ps", "-q", "kong");
  const child = execFile("docker", ["run", "--rm", "-i", "--network", `container:${id.trim()}`,
    NODE_IMAGE, "node", "--input-type=module", "-e", `
      import { readFileSync } from 'node:fs';
      const body = readFileSync(0, 'utf8');
      const response = await fetch(process.argv[1], {
        method: process.argv[2], headers: {'content-type': 'application/json'},
        ...(body ? {body} : {}), signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) throw new Error('Gateway helper HTTP ' + response.status);
      console.log(JSON.stringify(process.argv[2] === 'GET' ? await response.json() : {status: response.status}));
    `, endpoint, method], { cwd: root, env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  child.stdin.end(body === undefined ? "" : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", () => reject(new Error("Gateway helper failed")));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error("Gateway helper failed"));
      try { resolve(JSON.parse(output)); } catch { reject(new Error("Invalid gateway helper result")); }
    });
  });
}
// Beside Kong with its kong-admin volume: the Admin API listens only on a Unix socket (contract: agent-protocol).
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

async function login() {
  const base = process.env.CP_URL ?? "http://127.0.0.1:3000/api/v1";
  const response = await request(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@gromesh.dev",
      password: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "gromesh-dev-admin" }) });
  check(response.status === 200, "Admin login must succeed");
  const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  check(cookie.length > 0, "Admin session cookie must be present");
  const csrfResponse = await request(`${base}/auth/csrf`, { headers: { cookie } });
  check(csrfResponse.ok, "CSRF token request must succeed");
  const { csrfToken } = await csrfResponse.json();
  return async (method, path, status, body) => {
    const result = await request(base + path, { method,
      headers: { cookie, "x-csrf-token": csrfToken, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    check(result.status === status, `Control plane ${method} must return HTTP ${status}, got ${result.status}`);
    return status === 204 ? undefined : result.json();
  };
}

async function main() {
  // The timeouts below cover only the runs: the images are pulled first, with retries.
  await pullImages([VECTOR_IMAGE, NODE_IMAGE]);
  // An extra legacy name proves the env var still participates when event names are present.
  for (const directory of ["deploy/observability/vector", "deploy/helm/data-plane/files/vector"]) {
    await run(["run", "--rm", "-e", "CLICKHOUSE_PASSWORD=unit-test",
      "-e", "GROMESH_CLUSTER_ID=00000000-0000-4000-8000-00000000c0c0", "-e", 'GROMESH_KEY_NAMES=["legacy-key"]',
      "-v", `${root}${directory}:/etc/vector:ro`,
      "-v", `${root}deploy/observability/vector:/tests:ro`, VECTOR_IMAGE,
      "test", "--dangerously-allow-env-var-interpolation", "/etc/vector/vector.yaml",
      "/tests/key-names.tests.yaml", "/tests/path-masking.tests.yaml", "/tests/retention.tests.yaml"]);
  }
  await exec("pnpm", ["--filter", "@gromesh/compiler", "build"], { cwd: root, env, timeout: 60_000 });
  const { compile, platformPlugins } = await import("../packages/compiler/dist/index.js");
  const { stdout: agents } = await compose("ps", "--status", "running", "-q", "agent");
  check(agents.trim() === "", "Stop the compose agent before running: it would overwrite the test snapshot");
  const { stdout: logLevel } = await compose("exec", "-T", "vector", "printenv", "VECTOR_LOG");
  check(["info", "warn", "error", "off"].includes(logLevel.trim()), "Vector must run without debug/trace logging");
  const { stdout: fallback } = await compose("exec", "-T", "vector", "printenv", "GROMESH_KEY_NAMES");
  check(!JSON.parse(fallback).some((name) => name.toLowerCase() === "x-token"), "x-token must come from the snapshot, not the cluster env var");

  const api = await login();
  let environmentId;
  let prior;
  const startedAt = new Date().toISOString();
  // Distinct credentials make header and query leaks independently detectable. Never print them or raw responses.
  const secrets = [randomUUID(), randomUUID(), randomUUID()];
  const noSecrets = (text, label) => check(secrets.every((secret) => !text.toLowerCase().includes(secret.toLowerCase())), `${label} contains a credential`);
  try {
    const environment = await api("POST", "/environments", 201, { name: `key-names-${randomUUID()}`, publishMode: "manual" });
    environmentId = environment.id;
    const pluginPath = `/environments/${environmentId}/plugins`;
    const invalid = [null, "x-token", [], [42], [""], ["x token"], ["x/token"], ["a".repeat(65)], ['x"}; return "unsafe'], ["x\n"]];
    for (const key_names of invalid) {
      const problem = await api("POST", pluginPath, 422, { name: "key-auth", config: { key_names } });
      check(problem.errors?.some((error) => error.path === "config.key_names"), "Invalid key name must report config.key_names");
    }
    const empty = await api("GET", pluginPath, 200);
    check(empty.items.length === 0, "Rejected plugins must not be persisted");
    const plugin = await api("POST", pluginPath, 201, { name: "key-auth", config: { key_names: ["x-token"], hide_credentials: false } });
    const replaced = await api("PUT", `${pluginPath}/${plugin.id}`, 422, { name: "key-auth", config: { key_names: ["bad name"] } });
    check(replaced.errors?.some((error) => error.path === "config.key_names"), "Invalid replacement must report config.key_names");
    const publication = await api("POST", `/environments/${environmentId}/snapshots`, 201, {});
    const snapshot = await api("GET", `/environments/${environmentId}/snapshots/${publication.version}`, 200);
    const fields = snapshot.config.plugins.find((entry) => entry.name === "http-log")?.config.custom_fields_by_lua;
    check(fields?.key_names === 'return {"apikey","x-token"}', "Control plane publication must derive key_names from the configured plugins (apikey always included)");

    const serviceId = randomUUID();
    const routeId = randomUUID();
    const consumerId = randomUUID();
    const base = `/key-names-${environmentId}`;
    const config = compile({
      services: [{ id: serviceId, name: "key-names", protocol: "http", host: "echo", port: 80 }],
      routes: [
        { id: routeId, name: "key-names", serviceId, paths: [base], analyticsRetentionDays: 1 },
        { id: randomUUID(), name: "retention-default", serviceId, paths: [`${base}/default`] },
        { id: randomUUID(), name: "retention-seven", serviceId, paths: [`${base}/seven`], analyticsRetentionDays: 7 },
      ],
      consumers: [{ id: consumerId, username: "key-names" }],
      keyAuthCredentials: secrets.slice(0, 2).map((key) => ({ id: randomUUID(), consumerId, key })),
      plugins: [{ id: randomUUID(), name: "key-auth", scope: { routeId }, config: { key_names: ["x-token"], hide_credentials: false } }],
    }, { platformPlugins: platformPlugins({ environmentId, httpLogEndpoint: "http://gromesh-collector:8080/kong" }) });
    prior = await admin("GET");
    await admin("POST", config);
    for (let attempt = 0; ; attempt++) {
      const response = await request(`${proxy}${base}/ready`);
      await response.arrayBuffer();
      if (response.status === 401) break;
      check(attempt < 50, "Gateway workers must load the key-auth test route");
      await sleep(100);
    }
    const cases = [
      { label: "header", query: "", headers: { "X-ToKeN": secrets[0] }, status: 200, secret: secrets[0] },
      { label: "query", query: `?%78-token=${secrets[1]}`, headers: {}, status: 200, secret: secrets[1] },
      { label: "rejected", query: `?x-token=${secrets[2]}`, headers: {}, status: 401 },
      { label: "default/traffic", query: "", headers: {}, status: 200 },
      { label: "seven/traffic", query: "", headers: {}, status: 200 },
      { label: "unmatched", path: `/unmatched-${environmentId}`, query: "", headers: {}, status: 404 },
    ];
    for (const { label, path = `${base}/${label}`, query, headers, status, secret } of cases) {
      const response = await request(`${proxy}${path}${query}`, { headers });
      const body = await response.text();
      check(response.status === status, `Gateway ${label} request must return ${status}`);
      if (secret) check(body.includes(secret), "hide_credentials=false must leave credentials visible at the upstream");
    }
    // Force a sanitizer diagnostic while credentials are still in the event: logs must not echo them.
    await insideGateway("http://gromesh-collector:8080/kong", "POST", {
      environment_id: environmentId, key_names: ["x-token"],
      request: { uri: `${base}/malformed?x-token=${secrets[2]}`, headers: { "x-token": secrets[0] }, querystring: { "x-token": secrets[1] } },
    });
    const headers = { authorization: `Basic ${Buffer.from(`${process.env.CLICKHOUSE_USER ?? "gromesh"}:${process.env.CLICKHOUSE_PASSWORD ?? "gromesh-dev-observability"}`).toString("base64")}` };
    for (let attempt = 0; ; attempt++) {
      const response = await request(clickhouse, { method: "POST", headers,
        body: `SELECT * FROM gromesh.requests WHERE environment_id = '${environmentId}' FORMAT JSONEachRow` });
      check(response.ok, "ClickHouse query must succeed");
      const text = (await response.text()).trim();
      noSecrets(text, "ClickHouse columns");
      const rows = text ? text.split("\n").map((line) => JSON.parse(line)) : [];
      check(rows.every((row) => [`${base}/ready`, ...cases.map(({ label, path = `${base}/${label}` }) => path)].includes(row.path)), "Unexpected analytics path or unsanitized query");
      check(rows.every((row) => row.retention_days === (row.route_id === routeId ? 1 : 7)), "Matched retention and default/unmatched fallback must reach ClickHouse");
      if (cases.every(({ label, path = `${base}/${label}`, status }) => rows.some((row) => row.path === path && row.status === status))) break;
      check(attempt < 120, "Header, query, rejected, default-retention, seven-day and unmatched requests must arrive in ClickHouse within 30 seconds");
      await sleep(250);
    }
  } finally {
    try {
      if (prior) await admin("POST", prior);
    } finally {
      try {
        const logs = await compose("logs", "--no-color", "--since", startedAt, "vector");
        noSecrets(logs.stdout + logs.stderr, "Vector logs");
      } finally {
        try {
          if (environmentId) await api("DELETE", `/environments/${environmentId}`, 204);
        } finally { await api("POST", "/auth/logout", 204); }
      }
    }
  }
  console.log("Key names acceptance OK: VRL suites, API POST/PUT 422, published key_names, gateway header/query traffic, every ClickHouse column and Vector logs checked; prior config restored");
}

main().catch((error) => {
  // Print only value-free assertions: subprocess/fetch exceptions may carry raw configs or credentials.
  if (error instanceof assert.AssertionError) console.error(error.message);
  else if (process.env.CI) console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  else console.error("Key names acceptance failed; check compose service health and connectivity");
  process.exitCode = 1;
});

