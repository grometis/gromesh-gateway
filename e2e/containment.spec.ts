import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const script = fileURLToPath(new URL("./containment.mjs", import.meta.url));

test.beforeAll(async () => {
  test.setTimeout(180_000);
  await exec("pnpm", ["--filter", "@gromesh/compiler", "build"], { cwd: root, timeout: 170_000 });
});

test("a Workspace gateway serves only with a valid isolation lease", async () => {
  test.setTimeout(600_000);
  const { stdout } = await exec(process.execPath, [script], { timeout: 590_000, env: process.env });
  console.log(stdout.trim());
});

test("negative control: without the lease check and the supervisor the same checks fail", async () => {
  test.setTimeout(600_000);
  const run = exec(process.execPath, [script], { timeout: 590_000, env: { ...process.env, CONTAINMENT: "off" } });
  const failure = await run.then(() => null, (error: { stderr?: string }) => error.stderr ?? "");
  expect(failure, "containment must fail without its mechanisms").not.toBeNull();
  expect(failure).toContain("requests still served Infinity ms after the lease expired");
  expect(failure).toContain("Kong still running Infinity ms after the lease expired");
  expect(failure).toContain("a lease with duplicate-state kept Kong running");
  expect(failure).toContain("with the supervisor frozen an expired lease must get 503 within 1 s: 200");
});
