import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "@playwright/test";

test("published key-auth names redact analytics and invalid names return 422", async () => {
  test.setTimeout(180_000);
  const { stdout } = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL("./key-names.mjs", import.meta.url))], {
      timeout: 170_000, env: process.env,
    });
  console.log(stdout.trim());
});
