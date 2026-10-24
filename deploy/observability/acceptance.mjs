#!/usr/bin/env node
// Replaces Kong's in-memory config, like scripts/smoke.mjs. Leaves the stack up.
// POSTGRES_PORT=55433 node deploy/observability/acceptance.mjs
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = fileURLToPath(new URL("../../", import.meta.url));
const columns = ["id", "ts", "environment_id", "cluster_id", "service_id", "route_id", "consumer_id",
  "method", "path", "status", "latency_kong_ms", "latency_upstream_ms", "latency_total_ms",
  "client_ip", "request_size", "response_size", "retention_days"];
// Assertions never print raw events, responses, credentials, or subprocess output.
function check(ok, message) {
  if (!ok) throw new Error(message);
}
function noSecrets(value, secrets, label) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  check(secrets.every((secret) => !text.includes(secret)), `${label} contains a credential`);
}
function checkRecords(rows) {
  const ids = new Set();
  for (const row of rows) {
    check(JSON.stringify(Object.keys(row)) === JSON.stringify(columns), "Unexpected requests columns");
    check(typeof row.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.id), "Missing or invalid request UUID v4");
    check(!ids.has(row.id), "Duplicate request UUID");
    ids.add(row.id);
    check(typeof row.ts === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(row.ts)
      && Number.isFinite(Date.parse(`${row.ts.replace(" ", "T")}Z`)), "Invalid millisecond timestamp");
  }
}
async function request(url, options = {}, timeout = 5000) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
}

// Kong's Admin API listens only on a Unix socket in the kong-admin volume (contract: agent-protocol).
function admin(path, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: "/kong/admin/admin.sock", path, method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : {}, timeout: 5000 }, (res) => {
      let text = "";
      res.setEncoding("utf8").on("data", (chunk) => { text += chunk; }).on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("timeout", () => req.destroy(new Error("Admin API timeout"))).on("error", reject).end(body);
  });
}

async function inside() {
  const { config, environmentId, clusterId, base, secrets, keys, ids } = JSON.parse(readFileSync(0, "utf8"));
  const sql = async (query, timeout = 5000) => {
    const response = await request("http://clickhouse:8123/", {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`gromesh:${process.env.CLICKHOUSE_PASSWORD}`).toString("base64")}` },
      body: query,
    }, timeout);
    check(response.ok, `ClickHouse query failed (HTTP ${response.status})`);
    return response.text();
  };
  const info = JSON.parse((await admin("/")).text);
  check(info.configuration?.database === "off", "Kong must be DB-less");
  check(info.configuration?.admin_listen?.join() === "off", "Admin API must have no TCP listener");
  const applied = await admin("/config", JSON.stringify(config));
  check(applied.status === 201, `Kong rejected platform config (HTTP ${applied.status})`);

  // Wait for both workers to observe the declarative config, before timing.
  for (let attempt = 0; ; attempt++) {
    const response = await request(`http://127.0.0.1:8000${base}/ready`);
    await response.arrayBuffer();
    if (response.status === 401) break;
    check(attempt < 30, "Kong workers did not load the acceptance route");
    await sleep(100);
  }

  const started = performance.now();
  const expected = new Map();
  for (const [label, header, key, query] of [
    ["header", "apikey", keys[0], false],
    ["query", "apikey", keys[1], true],
    ["custom-header", "x-api-key", keys[2], false],
    ["custom-query", "x-api-key", keys[3], true],
  ]) {
    const path = `${base}/${label}`;
    const url = new URL(`http://127.0.0.1:8000${path}`);
    const headers = { authorization: `Bearer ${secrets[4]}`, cookie: `session=${secrets[5]}` };
    if (query) {
      // Percent-encoded parameter names exercise URI copies as well as querystring.
      url.search = `${header === "apikey" ? "%61pikey" : header}=${key}&safe=1`;
    } else headers[header] = key;
    const response = await request(url, { headers });
    check(response.status === 200, `${label} request did not reach the upstream`);
    const body = await response.text();
    // hide_credentials=false ensures the test does not rely on key-auth redaction.
    check(body.includes(key), `${label} credential did not reach the upstream`);
    expected.set(path, { status: 200, consumer: ids.consumer });
  }
  const rejectedPath = `${base}/rejected`;
  const rejected = await request(`http://127.0.0.1:8000${rejectedPath}?apikey=${secrets[6]}`);
  check(rejected.status === 401, "Invalid key must be rejected");
  await rejected.arrayBuffer();
  expected.set(rejectedPath, { status: 401, consumer: null });

  let elapsedMs;
  const poll = async (paths, deadline) => {
    while (performance.now() < deadline) {
      const rows = JSON.parse(await sql(
        `SELECT * FROM gromesh.requests WHERE environment_id = '${environmentId}' AND cluster_id = '${clusterId}' FORMAT JSON`,
        Math.max(1, Math.min(2000, Math.ceil(deadline - performance.now()))),
      )).data;
      noSecrets(rows, secrets, "ClickHouse columns");
      if ([...paths.keys()].every((path) => rows.some((row) => row.path === path))) return rows;
      await sleep(Math.min(100, Math.max(0, deadline - performance.now())));
    }
    throw new Error("Requests did not appear in ClickHouse within 10 seconds");
  };
  const rows = await poll(expected, started + 10000);
  elapsedMs = Math.round(performance.now() - started);
  check(elapsedMs <= 10000, "Kong to ClickHouse delivery exceeded 10 seconds");
  checkRecords(rows);
  for (const [path, expectation] of expected) {
    const row = rows.find((row) => row.path === path);
    check(row.environment_id === environmentId && row.cluster_id === clusterId, "Incorrect snapshot identity");
    check(row.service_id === ids.service && row.route_id === ids.route && row.consumer_id === expectation.consumer, "Incorrect entity attribution");
    check(row.method === "GET" && row.status === expectation.status, "Incorrect method/status");
    if (expectation.status === 401) {
      check(row.latency_upstream_ms === null, "Rejected request must have unknown upstream latency");
    } else {
      check(typeof row.latency_upstream_ms === "number" && Number.isFinite(row.latency_upstream_ms)
        && row.latency_upstream_ms >= 0, "Successful request must have a non-negative upstream latency");
    }
    check(row.client_ip === "::ffff:127.0.0.1", "Incorrect IPv4 to IPv6 mapping");
    for (const field of ["latency_kong_ms", "latency_total_ms", "request_size", "response_size"]) {
      check(Number.isFinite(Number(row[field])), `Invalid numeric field ${field}`);
    }
    check(Number(row.request_size) > 0 && Number(row.response_size) > 0, "Missing request/response sizes");
  }

  // Exercise single-object input, batches, response cookies and additional copies
  // that whoami cannot produce. Only the preceding rows count as Kong acceptance.
  const syntheticStartedAt = Math.floor(Date.now() / 1000) * 1000 + 123;
  const synthetic = (label) => ({
    environment_id: environmentId, cluster_id: clusterId, started_at: syntheticStartedAt,
    service: { id: ids.service, name: secrets[0] }, route: { id: ids.route, tags: secrets },
    consumer: { id: ids.consumer }, authenticated_entity: { key: secrets[1] },
    request: { method: "POST", uri: `${base}/${label}?apikey=${secrets[0]}&x-api-key=${secrets[2]}`,
      url: `http://example.test/?apikey=${secrets[1]}`, size: 100,
      headers: { APIKEY: secrets[0], "X-API-Key": secrets[2], Authorization: secrets[4], Cookie: secrets[5], Referer: `/?apikey=${secrets[0]}` },
      querystring: { apikey: secrets[0], "x-api-key": secrets[2], cookie: secrets[5] } },
    response: { status: 201, size: 200, headers: { "Set-Cookie": secrets[7], apikey: secrets[1] } },
    client_ip: "2001:db8::1", latencies: { kong: 1.25, proxy: 2.5, request: 3.75 },
  });
  const ingest = async (body) => {
    const response = await request("http://vector:8080/kong", { method: "POST", body }, 5000);
    check(response.ok, `Vector source rejected input (HTTP ${response.status})`);
    await response.arrayBuffer();
  };
  await ingest(JSON.stringify(synthetic("single")));
  await ingest(JSON.stringify([synthetic("batch-1"), synthetic("batch-2")]));
  await ingest(`malformed-json-${secrets[8]}`);
  const invalidFields = [
    ["client_ip"], ["started_at"], ["request", "method"], ["request", "size"],
    ["response", "status"], ["response", "size"], ["latencies", "kong"], ["latencies", "proxy"], ["latencies", "request"],
  ];
  for (const [parent, field] of invalidFields) {
    const event = synthetic("invalid");
    if (field) event[parent][field] = secrets[8];
    else event[parent] = secrets[8];
    await ingest(JSON.stringify(event));
  }
  const extra = new Map(["single", "batch-1", "batch-2"].map((label) => [`${base}/${label}`, {}]));
  const allRows = await poll(extra, performance.now() + 10000);
  checkRecords(allRows);
  check(!allRows.some((row) => row.path === `${base}/invalid`), "Malformed event was not dropped");
  for (const path of extra.keys()) {
    const row = allRows.find((item) => item.path === path);
    check(Date.parse(`${row.ts.replace(" ", "T")}Z`) === syntheticStartedAt, "Synthetic timestamp lost milliseconds");
    check(row.client_ip === "2001:db8::1" && row.latency_kong_ms === 1.25 && row.latency_upstream_ms === 2.5 && row.latency_total_ms === 3.75,
      "Synthetic mapping lost IPv6/latency precision");
  }
  const ddl = JSON.parse(await sql("SHOW CREATE TABLE gromesh.requests FORMAT JSON")).data[0].statement;
  check(ddl.includes("`id` UUID") && ddl.includes("`ts` DateTime64(3, 'UTC')")
    && ddl.includes("`latency_upstream_ms` Nullable(Float64)"), "Incorrect request identity, timestamp or upstream latency column types");
  check(ddl.includes("ORDER BY (environment_id, ts)") && ddl.includes("TTL ts + toIntervalDay(retention_days)"), "Incorrect sorting or TTL");
  // Check every column of the table, including events outside this run.
  noSecrets(await sql("SELECT * FROM gromesh.requests FORMAT JSONEachRow"), secrets, "ClickHouse table");

  const query = async (expression) => {
    const response = await request(`http://prometheus:9090/api/v1/query?query=${encodeURIComponent(expression)}`);
    check(response.ok, "Prometheus query must succeed");
    const metrics = await response.json();
    check(metrics.status === "success", "Prometheus query must return metrics");
    return metrics.data.result;
  };
  let scraped = false;
  let collectorScraped = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const [gateway, collector] = await Promise.all([
      query("kong_http_requests_total"),
      // Use the exact series consumed by CollectorWithoutEvents, including its namespace and labels.
      query('vector_component_sent_events_total{job="collector",component_id="sanitize"}'),
    ]);
    scraped = gateway.some((series) => series.metric.service === "echo" && Number(series.value[1]) > 0);
    collectorScraped = collector.some((series) => Number(series.value[1]) > 0);
    if (scraped && collectorScraped) break;
    await sleep(250);
  }
  check(scraped, "Prometheus did not scrape Kong request metrics through the status listener");
  check(collectorScraped, "Prometheus did not scrape the sanitized event counter used by CollectorWithoutEvents");
  console.log(JSON.stringify({ kongRows: expected.size, syntheticRows: extra.size, elapsedMs, prometheus: "OK", kongVersion: info.version }));
}

async function host() {
  // observability-acceptance runs this image (deploy/compose): pulled first, so the 90 s below cover only the run.
  // Imported here, not at the top: this file also runs inside that container, where e2e/ is not mounted.
  const { NODE_IMAGE, pullImages } = await import("../../e2e/docker-images.mjs");
  await pullImages([NODE_IMAGE]);
  const env = { ...process.env, POSTGRES_PORT: process.env.POSTGRES_PORT ?? "55433" };
  const run = (command, args, input) => execFileSync(command, args, {
    cwd: root, env, encoding: "utf8", input, timeout: 90000, maxBuffer: 16 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
  });
  run("pnpm", ["--filter", "@gromesh/compiler", "build"]);
  const { compile, platformPlugins } = await import("../../packages/compiler/dist/index.js");
  const state = JSON.parse(readFileSync(new URL("../../packages/compiler/test/fixtures/basic.state.json", import.meta.url), "utf8"));
  const environmentId = randomUUID();
  // The collector tags every row with its own cluster id (GROMESH_CLUSTER_ID): use the compose default.
  const clusterId = process.env.GROMESH_CLUSTER_ID ?? "00000000-0000-4000-8000-00000000c0c0";
  const base = `/observability-${randomUUID()}`;
  const secrets = Array.from({ length: 9 }, () => `acceptance-${randomBytes(24).toString("hex")}`);
  const keys = secrets.slice(0, 4);
  const ids = { service: state.services[0].id, route: state.routes[0].id, consumer: state.consumers[0].id };
  state.routes[0].paths = [base];
  state.plugins = state.plugins.filter((plugin) => plugin.name === "key-auth");
  state.plugins[0].config = { key_names: ["apikey", "x-api-key"], hide_credentials: false };
  state.keyAuthCredentials = keys.map((key) => ({ id: randomUUID(), consumerId: ids.consumer, key }));
  const config = compile(state, { platformPlugins: platformPlugins({
    httpLogEndpoint: "http://gromesh-collector:8080/kong", environmentId,
  }) });
  const compose = ["compose", "-f", "deploy/compose/docker-compose.yml", "--profile", "observability", "--profile", "observability-tools"];
  let output;
  let failure;
  try {
    output = run("docker", [...compose, "run", "--rm", "--no-deps", "-T", "observability-acceptance"],
      JSON.stringify({ config, environmentId, clusterId, base, secrets, keys, ids }));
  } catch (error) {
    noSecrets(`${error.stdout ?? ""}${error.stderr ?? ""}`, secrets, "Acceptance diagnostics");
    // Only our deliberate assertion messages can be printed safely.
    failure = String(error.stderr).match(/Acceptance failed: ([^\n]+)/)?.[1] ?? `Acceptance container failed (exit ${error.status})`;
  }
  const logs = run("docker", [...compose, "logs", "--no-color", "vector"]);
  noSecrets(logs, secrets, "Vector logs");
  if (failure) throw new Error(failure);
  noSecrets(output, secrets, "Acceptance report");
  console.log(`Acceptance OK: ${output.trim()}; no credentials in any ClickHouse column or Vector logs`);
}

if (process.argv.includes("--help")) {
  console.log("POSTGRES_PORT=55433 node deploy/observability/acceptance.mjs\nRequires pnpm dependencies and the running compose observability profile. Replaces Kong config; leaves the stack up.");
} else {
  try {
    if (process.argv.includes("--inside")) await inside();
    else await host();
  } catch (error) {
    console.error(`Acceptance failed: ${error.message}`);
    process.exitCode = 1;
  }
}
