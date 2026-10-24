import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "@playwright/test";

test("services aimed at the gateway itself never reach its Admin or status API", async () => {
  test.setTimeout(180_000);
  const { stdout } = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL("./admin-isolation.mjs", import.meta.url))], {
      timeout: 170_000, env: process.env,
    });
  console.log(stdout.trim());
});
