import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "@playwright/test";

for (const scenario of ["restart", "cold-nxdomain"]) {
  test(`collector ${scenario} with continuous traffic loses at most 10 seconds of events`, async () => {
    test.setTimeout(240_000);
    const { stdout } = await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL("./resilient-observability.mjs", import.meta.url)), ...(scenario === "cold-nxdomain" ? ["--cold-dns"] : [])], {
        timeout: 230_000, env: process.env,
      });
    console.log(stdout.trim());
  });
}
