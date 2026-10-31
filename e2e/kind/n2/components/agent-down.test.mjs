import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("./v2.mjs", import.meta.url), "utf8");
const scenario = source.slice(source.indexOf("async function agentDown()"), source.indexOf("// Posts to the pod's own Kong"));

// Exercise the runner's actual acceptance checks with recorded observations, without starting a lab or waiting 90 s.
async function evaluate({ events = [{ k: "new", s: 200 }, { k: "ka", s: 200 }], pend = [{ lifecycle: "communication-failure" }] } = {}) {
  const result = { failures: [], measures: {} };
  await runInNewContext(`${scenario}\nagentDown()`, {
    item: () => result, expect: (it, ok, why) => { if (!ok) it.failures.push(why); }, done: () => {},
    ctx: { proxy: { host: "fixture", port: 8000 }, ws: { A: { slug: "a", key: "test" } } },
    Client: class { since() { return events; } async stop() {} },
    sleep: async () => {}, live: async () => [{ name: "pod" }], freeze: async () => ({}), thaw: async () => {},
    vmNow: async () => 0, pendencies: async () => pend, waitFor: async () => true,
    kongExit: async () => ({ stopLog: null }),
  });
  return result;
}

test("agent failure scenario passes with traffic, an opened pendency and an intact WebSocket", async () => {
  assert.deepEqual((await evaluate()).failures, []);
});

test("agent failure scenario cannot pass with no traffic, no pendency, or a closed WebSocket", async () => {
  for (const [input, expected] of [
    [{ events: [] }, /no traffic/],
    [{ pend: [] }, /never opened/],
    [{ events: [{ k: "new", s: 200 }, { k: "ws", ev: "close" }] }, /WebSocket closed/],
  ]) {
    assert.match((await evaluate(input)).failures.join("\n"), expected);
  }
});
