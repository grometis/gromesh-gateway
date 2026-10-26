import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const script = fileURLToPath(new URL("./workspaces.mjs", import.meta.url));

test.beforeAll(async () => {
  test.setTimeout(180_000);
  await exec("pnpm", ["--filter", "@gromesh/compiler", "build"], { cwd: root, timeout: 170_000 });
});

test("a credential of one Workspace never authenticates on a route of another", async () => {
  test.setTimeout(300_000);
  const { stdout } = await exec(process.execPath, [script], { timeout: 290_000, env: process.env });
  console.log(stdout.trim());
});

test("negative control: without gromesh-workspace and gromesh-route-guard the same checks fail", async () => {
  test.setTimeout(300_000);
  const run = exec(process.execPath, [script], { timeout: 290_000, env: { ...process.env, WORKSPACE_PLUGINS: "off" } });
  const failure = await run.then(() => null, (error: { stderr?: string }) => error.stderr ?? "");
  expect(failure, "the isolation checks must fail without the product plugins").not.toBeNull();
  for (const mechanism of ["key-auth", "basic-auth", "jwt"]) {
    expect(failure).toContain(`${mechanism}: a credential of assine accepted on another Workspace's route /tvro/${mechanism.replace("-auth", "")} (200)`);
  }
  expect(failure).toContain("a path outside the Workspace prefix was served (200)");
  expect(failure).toContain("a consumer with two Workspace tags authenticated on /tvro/key (200)");
});
