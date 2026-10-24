import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("./admin-isolation.mjs", import.meta.url));
const composeFile = fileURLToPath(new URL("../deploy/compose/docker-compose.yml", import.meta.url));
const tcpAdmin = fileURLToPath(new URL("./admin-tcp.compose.yml", import.meta.url));
const env = process.env;

test("services aimed at the gateway itself never reach its Admin or status API", async () => {
  test.setTimeout(180_000);
  const { stdout } = await exec(process.execPath, [script], { timeout: 170_000, env });
  console.log(stdout.trim());
});

test("negative control: the same check fails against a TCP Admin API", async () => {
  test.setTimeout(300_000);
  const up = (...files: string[]) => exec("docker", ["compose", ...files.flatMap((f) => ["-f", f]), "up", "-d", "--wait", "kong"],
    { timeout: 120_000, env });
  await up(composeFile, tcpAdmin);
  try {
    const run = exec(process.execPath, [script], { timeout: 170_000, env: { ...env, COMPOSE_FILE: `${composeFile}:${tcpAdmin}` } });
    const failure = await run.then(() => null, (error: { stderr?: string }) => error.stderr ?? "");
    expect(failure, "the isolation check must fail with a TCP Admin API").not.toBeNull();
    expect(failure).toContain("Unexpected TCP listeners in the gateway: 8000,8001,8100,8443");
    expect(failure).toContain("Admin/status API reached through the proxy");
  } finally {
    await up(composeFile);
  }
});
