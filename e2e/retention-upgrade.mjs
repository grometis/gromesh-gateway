#!/usr/bin/env node
// Isolated containers only: never changes compose, publishes ports, or requires admin credentials on the data plane.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CLICKHOUSE_IMAGE, pullImages, VECTOR_IMAGE } from "./docker-images.mjs";

const exec = promisify(execFile);
const root = new URL("../", import.meta.url);
const schemaCheck = fileURLToPath(new URL("deploy/helm/data-plane/files/vector/check-clickhouse-schema.sh", root));
const read = (path) => readFileSync(new URL(path, root), "utf8");

async function main() {
  await pullImages([CLICKHOUSE_IMAGE, VECTOR_IMAGE]);
  const name = `gromesh-retention-upgrade-${randomUUID()}`;
  const run = (args) => exec("docker", args, { timeout: 60_000, maxBuffer: 1024 * 1024 });
  const sql = (query) => new Promise((resolve, reject) => {
    const child = execFile("docker", ["exec", "-i", name, "clickhouse-client", "-n"],
      { timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(new Error("Isolated ClickHouse query failed")) : resolve(stdout.trim()));
    child.stdin.end(query);
  });
  const check = () => run(["run", "--rm", "--network", `container:${name}`,
    "-e", "CLICKHOUSE_ENDPOINT=http://127.0.0.1:8123", "-e", "CLICKHOUSE_DATABASE_BASE64=Z3JvbWVzaA==",
    "-e", "CLICKHOUSE_PASSWORD=synthetic-writer-password", "-v", `${schemaCheck}:/check-schema.sh:ro`,
    "--entrypoint", "sh", VECTOR_IMAGE, "/check-schema.sh"]);
  const blocked = async () => {
    await assert.rejects(check(), (error) => error.code === 1 && error.stderr.includes("001-requests.sql then 002-retention.sql"));
  };
  try {
    await run(["run", "--rm", "-d", "--name", name, "--network", "none", CLICKHOUSE_IMAGE]);
    for (let attempt = 0; ; attempt++) {
      try { await sql("SELECT 1"); break; } catch {
        assert.ok(attempt < 60, "Isolated ClickHouse did not start");
        await sleep(250);
      }
    }
    await sql(read("deploy/observability/clickhouse/001-requests.sql") + `
      CREATE USER gromesh_writer IDENTIFIED BY 'synthetic-writer-password';
      GRANT INSERT ON gromesh.requests TO gromesh_writer;
      INSERT INTO gromesh.requests (id, ts, environment_id, cluster_id, path)
      VALUES ('${randomUUID()}', now(), '${randomUUID()}', '${randomUUID()}', '/legacy');`);
    await blocked();
    const migration = read("deploy/observability/clickhouse/002-retention.sql");
    await sql(migration);
    await sql(migration);
    assert.equal(await sql("SELECT count() FROM system.mutations WHERE database='gromesh' AND table='requests'"), "0", "Repeated migration must not materialize existing data");
    assert.equal(await sql("SELECT retention_days FROM gromesh.requests"), "7", "Existing rows must retain the seven-day default");
    await check();
    await sql("ALTER TABLE gromesh.requests MODIFY TTL ts + INTERVAL 7 DAY SETTINGS materialize_ttl_after_modify = 0");
    await blocked();
    await sql(migration);
    await sql("ALTER TABLE gromesh.requests MODIFY COLUMN retention_days UInt8 DEFAULT 1");
    await blocked();
    console.log("Retention upgrade OK: old schema, wrong TTL and wrong default blocked; migrated schema accepted by INSERT-only user; repeated migration created no mutations");
  } finally {
    await run(["rm", "-f", name]).catch(() => {});
  }
}

await main();
