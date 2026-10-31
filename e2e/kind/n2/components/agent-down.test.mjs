import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { itemResult } from "./budgets.mjs";

const source = readFileSync(new URL("./v2.mjs", import.meta.url), "utf8");
const scenario = source.slice(source.indexOf("async function agentDown()"), source.indexOf("// Posts to the pod's own Kong"));

// Exercise the runner's actual acceptance checks with recorded observations, without starting a lab or waiting 90 s.
const START = 100_000, END = 190_000;
async function evaluate({ events = [{ t: START, k: "new", s: 200 }, { t: END - 1, k: "ka", s: 200 }], pend = [{ lifecycle: "communication-failure" }], stopLog = null } = {}) {
  const result = { failures: [], open: [], measures: {} };
  let now = START - 5000;
  await runInNewContext(`${scenario}\nagentDown()`, {
    item: () => result, expect: (it, ok, why) => { if (!ok) it.failures.push(why); }, done: (it) => { it.result = itemResult(it); },
    ctx: { proxy: { host: "fixture", port: 8000 }, ws: { A: { slug: "a", key: "test" } } },
    Client: class { events = events; since(t) { return this.events.filter((e) => e.t >= t); } async stop() {} },
    sleep: async (ms) => { now += ms; }, live: async () => [{ name: "pod" }],
    freeze: async () => { now += 1000; return {}; }, thaw: async () => { now += 10_000; },
    vmNow: async () => now, pendencies: async () => pend, waitFor: async () => true,
    kongExit: async () => ({ stopLog }),
  });
  return result;
}

test("agent failure scenario passes with traffic, an opened pendency and an intact WebSocket", async () => {
  const result = await evaluate();
  assert.deepEqual(result.failures, []);
  assert.equal(result.result, "pass");
  assert.equal(result.measures.trafficWindow.startMs, START);
  assert.equal(result.measures.trafficWindow.endExclusiveMs, END);
  assert.equal(result.measures.trafficWindow.result, "PASS");
});

test("agent failure scenario cannot pass with no traffic, no pendency, or a closed WebSocket", async () => {
  for (const [input, expected] of [
    [{ events: [] }, /no traffic/],
    [{ pend: [] }, /never opened/],
    [{ events: [{ t: START, k: "new", s: 200 }, { t: START + 1, k: "ws", ev: "close" }] }, /WebSocket closed/],
  ]) {
    assert.match((await evaluate(input)).failures.join("\n"), expected);
  }
});

test("only traffic after SIGCONT cannot satisfy the frozen interval", async () => {
  const result = await evaluate({ events: [{ t: END + 10_001, k: "new", s: 200 }] });
  assert.equal(result.measures.total, 0);
  assert.match(result.failures.join("\n"), /no traffic/);
  assert.equal(result.result, "fail");
});

test("traffic exactly at the pre-SIGCONT boundary cannot satisfy the frozen interval", async () => {
  const result = await evaluate({ events: [{ t: END, k: "ka", s: 200 }] });
  assert.equal(result.measures.total, 0);
  assert.equal(result.result, "fail");
});

test("warmup traffic cannot satisfy the frozen interval", async () => {
  const result = await evaluate({ events: [{ t: START - 1, k: "new", s: 200 }] });
  assert.equal(result.measures.total, 0);
  assert.equal(result.result, "fail");
});

test("HTTP and WebSocket checks use the inclusive start and exclusive end timestamps", async () => {
  const result = await evaluate({ events: [
    { t: START - 1, k: "new", s: 503 }, { t: START - 1, k: "ws", ev: "close" },
    { t: START, k: "new", s: 200 }, { t: END - 1, k: "ka", s: 200 },
    { t: END, k: "new", s: 503 }, { t: END + 1, k: "ka", s: 503 }, { t: END, k: "ws", ev: "close" },
  ] });
  assert.equal(result.measures.total, 2);
  assert.equal(result.measures.non200, 0);
  assert.equal(result.measures.wsClosed, false);
  assert.equal(result.result, "pass");
});

test("missing or invalid event timestamps invalidate the observation with or without valid frozen traffic", async () => {
  for (const t of [undefined, null, "100001", NaN, Infinity]) {
    for (const event of [{ k: "new", s: 200 }, { k: "ws", ev: "close" }]) {
      for (const valid of [[], [{ t: START, k: "new", s: 200 }]]) {
        const result = await evaluate({ events: [...valid, { ...event, t }] });
        assert.equal(result.measures.trafficWindow?.result, "INVALID");
        assert.equal(result.measures.trafficWindow.invalidTimestamps, 1);
        assert.match(result.failures.join("\n"), /INVALID.*timestamp/);
        assert.equal(result.result, "fail");
      }
    }
  }
});

test("HTTP failures during the freeze still fail with a successful recovery response", async () => {
  const result = await evaluate({ events: [{ t: START, k: "new", s: 503 }, { t: END + 1, k: "new", s: 200 }] });
  assert.equal(result.measures.total, 1);
  assert.equal(result.measures.non200, 1);
  assert.equal(result.result, "fail");
});

test("Kong stops are checked only during the frozen interval", async () => {
  for (const [stopLog, expected] of [[START, "fail"], [END - 1, "fail"], [END, "pass"], [END + 1, "pass"]]) {
    assert.equal((await evaluate({ stopLog })).result, expected);
  }
});
