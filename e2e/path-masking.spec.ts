import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "@playwright/test";

test("analytics masks personal paths without changing UUIDs or short numeric ids", async () => {
  test.setTimeout(180_000);
  const { stdout } = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL("./path-masking.mjs", import.meta.url))], {
      timeout: 170_000, env: process.env,
    });
  console.log(stdout.trim());
});
