import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const entry = new URL("./host-events.mjs", import.meta.url).pathname;
test("direct host-events entry refuses implicit or mixed selection before creating evidence or running commands", () => {
  const dir = mkdtempSync(join(tmpdir(), "n2-host-selection-"));
  try {
    for (const suites of [undefined, "", "v2", "v2 host-events", "host-events v2"]) {
      const out = join(dir, "out");
      const env = { ...process.env, LAB_OUT: out, LAB_KUBECONFIG: "", HOST_EVENTS_MANIFEST: "" };
      if (suites === undefined) delete env.SUITES;
      else env.SUITES = suites;
      const child = spawnSync(process.execPath, [entry], { env, encoding: "utf8", timeout: 5000 });
      assert.ifError(child.error);
      assert.notEqual(child.status, 0);
      assert.match(child.stderr, /explicit SUITES=host-events required/);
      assert.equal(existsSync(out), false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("explicit host-events selection proceeds to prerequisite validation", () => {
  const child = spawnSync(process.execPath, [entry], {
    env: { ...process.env, SUITES: "host-events", LAB_OUT: "" }, encoding: "utf8", timeout: 5000,
  });
  assert.ifError(child.error);
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /LAB_OUT required/);
  assert.doesNotMatch(child.stderr, /explicit SUITES=host-events required/);
});
