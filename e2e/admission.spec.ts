import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const script = fileURLToPath(new URL("./admission.mjs", import.meta.url));

test.beforeAll(async () => {
  test.setTimeout(180_000);
  await exec("pnpm", ["--filter", "@gromesh/compiler", "build"], { cwd: root, timeout: 170_000 });
});

test("the probe accepts only trusted typed admissions and signs a chained report per round", async () => {
  test.setTimeout(900_000);
  const { stdout } = await exec(process.execPath, [script], { timeout: 890_000, env: process.env });
  console.log(stdout.trim());
});

test("negative control: a good admission, a kept key and a wrong digest fail the same checks", async () => {
  test.setTimeout(900_000);
  const run = exec(process.execPath, [script], { timeout: 890_000, env: { ...process.env, ADMISSION: "control" } });
  const failure = await run.then(() => null, (error: { stderr?: string }) => error.stderr ?? "");
  expect(failure, "the control must fail the admission checks").not.toBeNull();
  expect(failure).toContain("an admission of an unknown kid was accepted");
  expect(failure).toContain("a release presented as an admission was accepted");
  expect(failure).toContain("no 503 Infinity ms after the key left the trust set");
  expect(failure).toContain("the outbox chain is broken");
});
