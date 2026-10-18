import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "@playwright/test";

test("ClickHouse expires route analytics according to the retention recorded on each row", async () => {
  test.setTimeout(180_000);
  const { stdout } = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL("./route-retention.mjs", import.meta.url))], { timeout: 170_000, env: process.env });
  console.log(stdout.trim());
});

test("collector upgrade rejects an unmigrated external ClickHouse before new analytics are written", async () => {
  test.setTimeout(180_000);
  const { stdout } = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL("./retention-upgrade.mjs", import.meta.url))], { timeout: 170_000, env: process.env });
  console.log(stdout.trim());
});
