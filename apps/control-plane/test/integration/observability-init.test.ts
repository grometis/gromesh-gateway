import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = new URL("../../../../", import.meta.url);
const hook = fileURLToPath(new URL("deploy/helm/data-plane/files/vector/check-clickhouse-schema.sh", root));
const init = fileURLToPath(new URL("deploy/observability/clickhouse-init/users.sh", root));

test.each([
  ["ready", "1", "1", 0, "ClickHouse retention schema ready"],
  ["without 001", "0", "0", 1, "migration 001-requests.sql is missing"],
  ["without 002", "1", "0", 1, "migration 002-retention.sql is missing"],
  ["unreachable", "http-error", "http-error", 1, "is unreachable"],
] as const)("external ClickHouse %s gates the collector upgrade", (_name, table, retention, status, message) => {
  const dir = mkdtempSync(join(tmpdir(), "gromesh-hook-"));
  try {
    const capture = join(dir, "args");
    // The first query asks for the table (001), the second for the retention column and TTL (002).
    writeFileSync(join(dir, "wget"), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$CAPTURE"\ncase "$*" in *system.columns*) answer="$MOCK_RETENTION";; *) answer="$MOCK_TABLE";; esac\n[ "$answer" != http-error ] || exit 1\nprintf "%s" "$answer"\n', { mode: 0o755 });
    const result = spawnSync("sh", [hook], { encoding: "utf8", env: {
      ...process.env, PATH: `${dir}:${process.env.PATH}`, CAPTURE: capture, MOCK_TABLE: table, MOCK_RETENTION: retention,
      CLICKHOUSE_ENDPOINT: "http://clickhouse:8123", CLICKHOUSE_DATABASE_BASE64: Buffer.from("gromesh").toString("base64"), CLICKHOUSE_PASSWORD: "synthetic-writer-password",
    } });
    expect(result.status).toBe(status);
    expect(result.stdout + result.stderr).toContain(message);
    if (message.startsWith("migration")) expect(result.stderr).toContain(`-n < deploy/observability/clickhouse/${message.split(" ")[1]}`);
    expect(result.stderr).not.toContain("synthetic-writer-password");
    const args = readFileSync(capture, "utf8");
    expect(args).toContain("X-ClickHouse-User: gromesh_writer");
    if (table === "1") {
      expect(args).toContain("system.columns");
      expect(args).toContain("type = 'UInt8'");
      expect(args).toContain("default_expression = '7'");
      expect(args).toContain("TTL ts + toIntervalDay(retention_days)");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.each(["missing", "empty", "populated"])("ClickHouse init tolerates a %s migrations directory", (kind) => {
  const dir = mkdtempSync(join(tmpdir(), "gromesh-init-"));
  try {
    const migrations = join(dir, "migrations");
    if (kind !== "missing") mkdirSync(migrations);
    if (kind === "populated") {
      writeFileSync(join(migrations, "002-retention.sql"), "-- retention migration\n");
      writeFileSync(join(migrations, "001-requests.sql"), "-- table migration\n");
    }
    const capture = join(dir, "queries");
    writeFileSync(join(dir, "clickhouse-client"), '#!/bin/sh\ncat >> "$CAPTURE"\n', { mode: 0o755 });
    const result = spawnSync("sh", [init], { encoding: "utf8", env: {
      ...process.env, PATH: `${dir}:${process.env.PATH}`, CAPTURE: capture, CLICKHOUSE_MIGRATIONS_DIR: migrations,
      CLICKHOUSE_USER: "synthetic-admin", CLICKHOUSE_PASSWORD: "synthetic-admin-password",
      CLICKHOUSE_WRITER_PASSWORD: "synthetic-writer-password", CLICKHOUSE_READER_PASSWORD: "synthetic-reader-password",
    } });
    expect(result.status, result.stderr).toBe(0);
    const queries = readFileSync(capture, "utf8");
    expect(queries).toContain("GRANT INSERT");
    if (kind === "populated") {
      expect(queries.indexOf("-- table migration")).toBeLessThan(queries.indexOf("-- retention migration"));
      expect(queries.indexOf("-- retention migration")).toBeLessThan(queries.indexOf("GRANT INSERT"));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
