import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "@playwright/test";

test("the collector takes only checked environment values, without Vector's env interpolation", async () => {
  test.setTimeout(420_000);
  const { stdout } = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL("./vector-config.mjs", import.meta.url))], {
      timeout: 410_000, env: process.env,
    });
  console.log(stdout.trim());
});
