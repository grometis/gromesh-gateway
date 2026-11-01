#!/usr/bin/env node
// Requires compose observability and a stopped agent; restores the prior opaque gateway config.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { NODE_IMAGE, pullImages, VECTOR_IMAGE } from "./docker-images.mjs";
import { assertStack } from "../scripts/stack-guard.mjs";

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
// The compose collector's token (hotfix F-1): the sanitizer cases below post straight to it, like the gateway does.
const collectorToken = process.env.GROMESH_COLLECTOR_TOKEN ?? "gromesh-dev-collector-token-not-a-secret";

// Execute inside Kong's network namespace (the collector is on the compose network). Never print responses/configs.
async function insideGateway(endpoint, method, body) {
  const { stdout: id } = await compose("ps", "-q", "kong");
  const child = execFile("docker", ["run", "--rm", "-i", "--network", `container:${id.trim()}`,
    NODE_IMAGE, "node", "--input-type=module", "-e", `
      import { readFileSync } from 'node:fs';
      const body = readFileSync(0, 'utf8');
      const response = await fetch(process.argv[1], {
        method: process.argv[2], headers: {'content-type': 'application/json', 'x-gromesh-collector-token': process.argv[3]},
        ...(body ? {body} : {}), signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) throw new Error('Gateway helper HTTP ' + response.status);
      console.log(JSON.stringify(process.argv[2] === 'GET' ? await response.json() : {status: response.status}));
    `, endpoint, method, collectorToken], { cwd: root, env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
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

async function main() {
  await assertStack("acceptance");
  // The timeouts below cover only the runs: the images are pulled first, with retries.
  await pullImages([VECTOR_IMAGE, NODE_IMAGE]);
  for (const directory of ["deploy/observability/vector", "deploy/helm/data-plane/files/vector"]) {
    await run(["run", "--rm", "-e", "CLICKHOUSE_PASSWORD=unit-test",
      "-e", "GROMESH_CLUSTER_ID=00000000-0000-4000-8000-00000000c0c0", "-e", "GROMESH_ENVIRONMENT_ID=any", "-e", 'GROMESH_KEY_NAMES=["legacy-key"]',
      "-v", `${root}${directory}:/etc/vector:ro`,
      "-v", `${root}deploy/observability/vector:/tests:ro`, VECTOR_IMAGE,
      "test", "--dangerously-allow-env-var-interpolation", "/etc/vector/vector.yaml",
      "/tests/key-names.tests.yaml", "/tests/path-masking.tests.yaml"]);
  }
  await exec("pnpm", ["--filter", "@gromesh/compiler", "build"], { cwd: root, env, timeout: 60_000 });
  const { compile, platformPlugins } = await import("../packages/compiler/dist/index.js");
  const { stdout: agents } = await compose("ps", "--status", "running", "-q", "agent");
  check(agents.trim() === "", "Stop the compose agent before running: it would overwrite the test snapshot");
  const { stdout: logLevel } = await compose("exec", "-T", "vector", "printenv", "VECTOR_LOG");
  check(["info", "warn", "error", "off"].includes(logLevel.trim()), "Vector must run without debug/trace logging");

  const environmentId = randomUUID();
  const serviceId = randomUUID();
  const base = `/path-masking-${environmentId}`;
  const patterns = [
    ["cpf-punctuated", "123.456.789-09", "{cpf}"],
    ["cpf", "12345678909", "{cpf}"],
    ["cnpj-punctuated", "12.345.678/0001-95", "{cnpj}"],
    ["cnpj", "12345678000195", "{cnpj}"],
    ["email", "test.12345678909+tag@example.test", "{email}"],
    ["number-six", "654321", "{id}"],
    ["number-long", "98765432109876543210", "{id}"],
    ["hex-segment", "mvp-629762c6", "{id}"],
    ["object-id", "507f1f77bcf86cd799439011", "{id}"],
    ["adjacent-numbers", "123456-654321", "{id}"],
    ["embedded-cpf", "prefix-12345678909", "{id}"],
    ["embedded-cnpj", "12345678000195-suffix", "{id}"],
    ["email-precedence", "654321(test@example.test)987654", "{email}"],
  ];
  const percentEncode = (value) => [...Buffer.from(value)].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
  const privateValues = new Set(patterns.flatMap(([, value]) => [value, encodeURIComponent(value), percentEncode(value)]));
  const noPersonalData = (text, label) => {
    check([...privateValues].every((value) => !text.toLowerCase().includes(value.toLowerCase())), `${label} contains unmasked personal data`);
  };
  const cases = patterns.flatMap(([label, value, marker]) => [
    { label, uri: `${base}/${label}/${value}`, expected: `${base}/${label}/${marker}` },
    { label: `${label}-encoded`, uri: `${base}/${label}-encoded/${percentEncode(value)}`, expected: `${base}/${label}-encoded/${marker}` },
    { label: `${label}-query`, uri: `${base}/${label}-query?value=${encodeURIComponent(value)}`, expected: `${base}/${label}-query` },
  ]);
  // Numeric UUIDs make regressions deterministic, including UUIDs with a test prefix.
  const controlUuid = "12345678-1234-1234-1234-123456789012";
  const controlPaths = [`/mvp-${controlUuid}`, `/e2e-${controlUuid}/traffic-0`];
  cases.push(
    { label: "root-hex-segment", uri: "/mvp-629762c6", expected: "/{id}" },
    { label: "root-object-id", uri: "/orders/507f1f77bcf86cd799439011", expected: "/orders/{id}" },
    ...controlPaths.flatMap((path, i) => [
      { label: `prefixed-uuid-${i}`, uri: path, expected: path },
      { label: `prefixed-uuid-encoded-${i}`, uri: path.replace(controlUuid, percentEncode(controlUuid)), expected: path },
    ]),
    { label: "short-id", uri: "/v1/pedidos/123", expected: "/v1/pedidos/123" },
    { label: "five-digits", uri: "/v1/pedidos/12345", expected: "/v1/pedidos/12345" },
    ...["12345678-1234-1234-1234-123456789012", "ABCDEF12-3456-7890-ABCD-123456789012"].map((uuid, i) => ({
      label: `uuid-${i}`, uri: `${base}/uuid/${uuid}`, expected: `${base}/uuid/${uuid}`,
    })),
    { label: "mixed", uri: `${base}/mixed/${patterns.map(([, value]) => value).join("/")}`,
      expected: `${base}/mixed/${patterns.map(([, , marker]) => marker).join("/")}` },
  );
  const config = compile({
    services: [{ id: serviceId, name: "path-masking", protocol: "http", host: "echo", port: 80 }],
    routes: [{ id: randomUUID(), name: "path-masking", serviceId, paths: [base, "/v1/pedidos", "/mvp-629762c6", "/orders", ...controlPaths] }],
    consumers: [], keyAuthCredentials: [], plugins: [],
  }, { platformPlugins: platformPlugins({ environmentId, httpLogEndpoint: "http://gromesh-collector:8080/kong" }) });
  const headers = { authorization: `Basic ${Buffer.from(`${process.env.CLICKHOUSE_USER ?? "gromesh"}:${process.env.CLICKHOUSE_PASSWORD ?? "gromesh-dev-observability"}`).toString("base64")}` };
  const sql = async (columns) => {
    const response = await request(clickhouse, { method: "POST", headers,
      body: `SELECT ${columns} FROM gromesh.requests WHERE environment_id = '${environmentId}' FORMAT JSONEachRow` });
    check(response.ok, "ClickHouse query must succeed");
    const text = (await response.text()).trim();
    noPersonalData(text, "ClickHouse columns");
    return text ? text.split("\n").map((line) => JSON.parse(line)) : [];
  };
  const prior = await admin("GET");
  const startedAt = new Date().toISOString();
  try {
    await admin("POST", config);
    for (let attempt = 0; ; attempt++) {
      const response = await request(`${proxy}${base}/ready`);
      await response.arrayBuffer();
      if (response.status === 200) break;
      check(attempt < 50, "Gateway workers must load the test route");
      await sleep(100);
    }
    for (const { label, uri } of cases) {
      const response = await request(proxy + uri);
      await response.arrayBuffer();
      check(response.status === 200, `Gateway request failed for case ${label}`);
    }

    // Trigger a sanitizer failure with a personal path: diagnostics must not echo the event.
    await insideGateway("http://gromesh-collector:8080/kong", "POST", {
      environment_id: environmentId, request: { uri: `${base}/invalid/${patterns.map(([, value]) => value).join("/")}` },
    });

    let rows;
    for (let attempt = 0; ; attempt++) {
      rows = await sql("path");
      if (cases.every(({ expected }) => rows.some(({ path }) => path === expected))) break;
      check(attempt < 120, "Masked paths and control paths must arrive in ClickHouse within 30 seconds");
      await sleep(250);
    }
    const allowed = new Set([`${base}/ready`, ...cases.map(({ expected }) => expected)]);
    check(rows.every(({ path }) => allowed.has(path)), "Unexpected or incompletely masked analytics path");
    await sql("*");
  } finally {
    try { await admin("POST", prior); } finally {
      const logs = await compose("logs", "--no-color", "--since", startedAt, "vector");
      noPersonalData(logs.stdout + logs.stderr, "Vector logs");
    }
  }
  console.log(`Path masking acceptance OK: ${cases.length} gateway cases, VRL unit tests, ClickHouse columns and Vector logs checked; prior config restored`);
}

main().catch((error) => {
  // Fetch/subprocess exceptions can contain URLs or config: outside CI only deliberate, value-free assertions are
  // printed; in CI the message and stack are shown (never the subprocess streams).
  if (error instanceof assert.AssertionError) console.error(error.message);
  else if (process.env.CI) console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  else console.error("Path masking acceptance failed; check compose service health and connectivity");
  process.exitCode = 1;
});
