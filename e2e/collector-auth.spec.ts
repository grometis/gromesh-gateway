import { execFile } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { composeFiles } from "../scripts/stack-guard.mjs";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("./collector-auth.mjs", import.meta.url));
// COMPOSE_FILE when set: an isolated run keeps its own overrides in these explicit `-f` calls too.
const composeFile = composeFiles(fileURLToPath(new URL("../deploy/compose/docker-compose.yml", import.meta.url)));
const vectorDir = fileURLToPath(new URL("../deploy/observability/vector/", import.meta.url));
const env = process.env;

test("events forged through the proxy never reach the collector's storage", async () => {
  test.setTimeout(180_000);
  const { stdout } = await exec(process.execPath, [script], { timeout: 170_000, env });
  console.log(stdout.trim());
});

test("negative control: the same check fails against the collector without authentication", async () => {
  test.setTimeout(300_000);
  // The real vector.yaml minus its auth block: the collector as it was before the hotfix.
  const dir = mkdtempSync(join(tmpdir(), "gromesh-open-collector-"));
  cpSync(vectorDir, dir, { recursive: true });
  const original = readFileSync(join(vectorDir, "vector.yaml"), "utf8");
  const open = original.replace(/\n {4}# Only this cluster's gateways[\s\S]*?\n {8}got != "" && \(got == current \|\| got == previous\)\n/, "\n");
  expect(open, "the auth block must be found and removed").not.toBe(original);
  writeFileSync(join(dir, "vector.yaml"), open);
  const override = join(dir, "open-collector.compose.yml");
  writeFileSync(override, `services:\n  vector:\n    volumes:\n      - ${dir}:/etc/vector:ro\n`);
  // mkdtemp is 0700: the collector runs as 65534 and must read the copy.
  chmodSync(dir, 0o755);
  for (const name of readdirSync(dir)) chmodSync(join(dir, name), 0o644);
  const up = (...files: string[]) => exec("docker", ["compose", ...files.flatMap((f) => ["-f", f]), "--profile", "observability",
    "up", "-d", "--wait", "--force-recreate", "--no-deps", "vector"], { timeout: 120_000, env });
  try {
    await up(...composeFile, override);
    const failure = await exec(process.execPath, [script], { timeout: 170_000, env: { ...env, COMPOSE_FILE: [...composeFile, override].join(":") } })
      .then(() => null, (error: { stderr?: string }) => error.stderr ?? "");
    expect(failure, "the check must fail against an unauthenticated collector").not.toBeNull();
    expect(failure).toContain("A forged event without a valid token reached ClickHouse through the proxy");
  } finally {
    await up(...composeFile);
    rmSync(dir, { recursive: true, force: true });
  }
});
