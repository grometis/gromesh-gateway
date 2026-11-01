#!/usr/bin/env node
// ClickHouse-only acceptance: never changes the gateway or collector, and deletes only its own test rows.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertStack } from "../scripts/stack-guard.mjs";

export async function retentionAcceptance() {
  await assertStack("acceptance");
  const environmentId = randomUUID();
  const shortRoute = randomUUID();
  const defaultRoute = randomUUID();
  const endpoint = process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
  const user = process.env.CLICKHOUSE_USER ?? "gromesh";
  const password = process.env.CLICKHOUSE_PASSWORD ?? "gromesh-dev-observability";
  const sql = async (query) => {
    const response = await fetch(endpoint, { method: "POST", body: query,
      headers: { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` },
      signal: AbortSignal.timeout(60_000) });
    assert.ok(response.ok, `ClickHouse acceptance query failed (HTTP ${response.status})`);
    return response.text();
  };
  const rows = async () => JSON.parse(await sql(`SELECT path, retention_days FROM gromesh.requests
    WHERE environment_id = '${environmentId}' ORDER BY path FORMAT JSON`)).data;
  try {
    const oldTimestamp = (await sql("SELECT formatDateTime(now('UTC') - INTERVAL 2 DAY, '%Y-%m-%d %H:%i:%S', 'UTC') FORMAT TabSeparated")).trim();
    assert.match(oldTimestamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const partition = oldTimestamp.slice(0, 10);
    assert.match(partition, /^\d{4}-\d{2}-\d{2}$/);
    // The two policies share an old partition: TTL must remove rows, rather than dropping the entire part.
    await sql(`INSERT INTO gromesh.requests (id, ts, environment_id, cluster_id, route_id, path, retention_days) VALUES
      ('${randomUUID()}', '${oldTimestamp}', '${environmentId}', '${environmentId}', '${shortRoute}', '/expired-short', 1),
      ('${randomUUID()}', '${oldTimestamp}', '${environmentId}', '${environmentId}', '${defaultRoute}', '/kept-seven', 7),
      ('${randomUUID()}', now(), '${environmentId}', '${environmentId}', '${shortRoute}', '/recent-short', 1)`);
    // Old producers omit the column; their rows must still receive the seven-day default.
    await sql(`INSERT INTO gromesh.requests (id, ts, environment_id, cluster_id, route_id, path) VALUES
      ('${randomUUID()}', '${oldTimestamp}', '${environmentId}', '${environmentId}', '${defaultRoute}', '/legacy-default')`);
    await sql(`OPTIMIZE TABLE gromesh.requests PARTITION '${partition}' FINAL SETTINGS optimize_skip_merged_partitions = 0`);
    assert.deepEqual(await rows(), [
      { path: "/kept-seven", retention_days: 7 },
      { path: "/legacy-default", retention_days: 7 },
      { path: "/recent-short", retention_days: 1 },
    ], "Expired one-day rows must be removed, while seven-day and recent rows survive");
    return "Retention acceptance OK: expired 1-day rows removed; 7-day, legacy and recent rows retained";
  } finally {
    await sql(`ALTER TABLE gromesh.requests DELETE WHERE environment_id = '${environmentId}' SETTINGS mutations_sync = 2`);
    assert.deepEqual(await rows(), [], "Acceptance rows must be cleaned up");
  }
}

if (process.argv.includes("--help")) {
  console.log("node e2e/route-retention.mjs: test the migrated compose ClickHouse TTL with isolated rows; no service restarts");
} else if (import.meta.url === new URL(process.argv[1], "file:").href) {
  console.log(await retentionAcceptance());
}
