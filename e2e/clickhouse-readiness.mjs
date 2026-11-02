#!/usr/bin/env node
// CLICKHOUSE_READINESS_LEGACY=1 must fail while initdb is blocked, proving the old probe's false positive.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertStandalone, disposableDocker } from "../scripts/disposable-docker.mjs";
import { pullImages } from "./docker-images.mjs";

await assertStandalone();

const root = fileURLToPath(new URL("../", import.meta.url));
const execute = (args) => new Promise((resolve, reject) => {
  execFile("docker", args, { cwd: root, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
    (error, stdout) => error
      ? reject(Object.assign(new Error(`Isolated ClickHouse ${args[0]} failed`), { code: error.code }))
      : resolve({ stdout }));
});
const name = `gromesh-ch-readiness-${randomUUID()}`;
const { stdout } = await execute(["compose", "--project-name", name, "--env-file", "/dev/null",
  "-f", "deploy/compose/docker-compose.yml", "--profile", "observability", "config", "--format", "json"]);
const service = JSON.parse(stdout).services.clickhouse;
assert.equal(service.healthcheck.test[0], "CMD-SHELL");
// Compose versions may preserve $$ in config output; Docker ultimately receives a single $.
const health = process.env.CLICKHOUSE_READINESS_LEGACY === "1"
  ? "wget -q -O /dev/null http://127.0.0.1:8123/ping"
  : service.healthcheck.test[1].replaceAll("$$", "$");
await pullImages([service.image]);

const work = mkdtempSync(join(tmpdir(), "gromesh-ch-readiness-"));
const docker = disposableDocker(execute, process.env.GROMESH_DISPOSABLE_ID, { bindRoots: [work] });
// Each Docker command waits for a real observation; initdb cannot finish until the FIFO is released.
async function until(label, check) {
  const deadline = Date.now() + 120_000;
  do {
    if (await check()) return;
    const { stdout } = await docker(["inspect", "--format", "{{.State.Running}}", name]);
    assert.equal(stdout.trim(), "true", `ClickHouse exited while waiting for ${label}`);
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${label}`);
}
const succeeds = (args) => docker(args).then(() => true, error => {
  if (error.code === 1) return false;
  throw error;
});
let networkCreated = false;

try {
  cpSync(join(root, "deploy/observability/clickhouse"), work, { recursive: true });
  writeFileSync(join(work, "999-readiness-block.sh"), `#!/bin/sh
set -eu
mkfifo /readiness/release
IFS= read -r signal < /readiness/release
[ "$signal" = release ]
`, { mode: 0o755 });
  await docker(["network", "create", name]);
  networkCreated = true;
  await docker(["run", "-d", "--name", name, "--network", name,
    "--tmpfs", "/var/lib/clickhouse", "--tmpfs", "/var/log/clickhouse-server", "--tmpfs", "/readiness",
    "-v", `${work}:/docker-entrypoint-initdb.d:ro`,
    "-e", "CLICKHOUSE_DB=gromesh", "-e", "CLICKHOUSE_USER=gromesh",
    "-e", "CLICKHOUSE_PASSWORD=synthetic-readiness-password", "-e", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1",
    "--health-cmd", health, "--health-interval", service.healthcheck.interval,
    "--health-timeout", service.healthcheck.timeout, "--health-retries", String(service.healthcheck.retries), service.image]);

  await until("blocked initdb", () => succeeds(["exec", name, "test", "-p", "/readiness/release"]));
  await docker(["exec", name, "sh", "-c", "wget -q -O /dev/null http://127.0.0.1:8123/ping"]);
  assert.equal(await succeeds(["exec", name, "sh", "-c", health]), false,
    "Healthcheck accepted the temporary server while initdb was blocked");

  await docker(["exec", name, "sh", "-c", "printf 'release\\n' > /readiness/release"]);
  await until("Docker healthy after initdb", async () => {
    const { stdout } = await docker(["inspect", "--format", "{{.State.Health.Status}}", name]);
    return stdout.trim() === "healthy";
  });
  await docker(["exec", name, "sh", "-c", health]);
  await docker(["exec", name, "sh", "-c",
    'clickhouse-client --host "$(hostname)" --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --query "SELECT 1"']);
  console.log("ClickHouse readiness OK: initdb rejected; final HTTP and native listeners accepted");
} finally {
  try {
    await docker(["rm", "-f", name]);
  } finally {
    try {
      if (networkCreated) await docker(["network", "rm", name]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}
