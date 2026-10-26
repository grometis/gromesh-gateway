import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const script = fileURLToPath(new URL("./probe.mjs", import.meta.url));

test.beforeAll(async () => {
  test.setTimeout(180_000);
  await exec("pnpm", ["--filter", "@gromesh/compiler", "build"], { cwd: root, timeout: 170_000 });
});

test("the isolation-probe is the only source of the lease and contains a violation", async () => {
  test.setTimeout(900_000);
  const { stdout } = await exec(process.execPath, [script], { timeout: 890_000, env: process.env });
  console.log(stdout.trim());
});

test("negative control: a probe blind to the reachable target never contains it", async () => {
  test.setTimeout(900_000);
  const run = exec(process.execPath, [script], { timeout: 890_000, env: { ...process.env, PROBE: "blind" } });
  const failure = await run.then(() => null, (error: { stderr?: string }) => error.stderr ?? "");
  expect(failure, "the blind probe must fail the containment checks").not.toBeNull();
  expect(failure).toContain("requests still served Infinity ms after a forbidden target became reachable");
  expect(failure).toContain("a violation must outlive its target and a probe restart");
});
