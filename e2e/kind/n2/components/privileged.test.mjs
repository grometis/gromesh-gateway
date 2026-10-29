// node --test e2e/kind/n2/components/privileged.test.mjs — the privileged destination's connection log, without a lab.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { privilegedAfterLoss } from "./privileged.mjs";

const BOOT = "7d2c1e9a-0b4f-4f0e-9d3a-1c2b3a4d5e6f";
const LOSS = 1_000_000;
const opts = { lossMs: LOSS, limitMs: 20_000, windowMs: 40_000, refBootId: BOOT };
/** A server log: heartbeats every second over the window, plus the given events (wall times relative to the loss). */
function log(events, { inst = "aaaa0001", boot = BOOT, beatsUntil = 40_000, skipBeats = [] } = {}) {
  const all = [];
  for (let t = 0; t <= beatsUntil; t += 1000) if (!skipBeats.includes(t)) all.push({ ev: "heartbeat", t });
  all.push(...events);
  all.sort((a, b) => a.t - b.t);
  return all.map((e, i) => JSON.stringify({ ev: e.ev, server: "ext:imds", inst: e.inst ?? inst, seq: e.seq ?? i + 1, boot: e.boot ?? boot, wallMs: LOSS + e.t, monoNs: "0", ...(e.conn ? { conn: e.conn } : {}) }));
}

test("traffic after the loss that stops by the limit passes", () => {
  const r = privilegedAfterLoss(log([{ ev: "accept", t: 2_000, conn: 1 }, { ev: "data", t: 2_100, conn: 1 }, { ev: "accept", t: 15_000, conn: 2 }]), opts);
  assert.equal(r.result, "PASS");
  assert.equal(r.connections, 2);
});

test("negative controls: a connection accepted after 20 s, or a request on a persistent one, fails", () => {
  assert.equal(privilegedAfterLoss(log([{ ev: "accept", t: 2_000, conn: 1 }, { ev: "accept", t: 21_000, conn: 2 }]), opts).result, "FAIL");
  const persistent = privilegedAfterLoss(log([{ ev: "accept", t: 2_000, conn: 1 }, { ev: "data", t: 25_000, conn: 1 }]), opts);
  assert.equal(persistent.result, "FAIL");
  assert.match(persistent.reason, /persistent connection/);
});

test("absence is never a pass: no traffic after the loss is not exercised", () => {
  assert.equal(privilegedAfterLoss(log([]), opts).result, "NOT_EXERCISED");
});

test("an observer not proven alive is invalid: no log, a dead server, a heartbeat gap", () => {
  assert.equal(privilegedAfterLoss([], opts).result, "INVALID");
  assert.equal(privilegedAfterLoss(["not json", "{}"], opts).result, "INVALID");
  // The server died at 10 s: no heartbeat afterwards (so a later connection could not have been seen).
  assert.equal(privilegedAfterLoss(log([{ ev: "accept", t: 2_000, conn: 1 }], { beatsUntil: 10_000 }), opts).result, "INVALID");
  assert.equal(privilegedAfterLoss(log([{ ev: "accept", t: 2_000, conn: 1 }], { skipBeats: [12_000, 13_000] }), opts).result, "INVALID");
});

test("no correlation, mixed runs or duplicates are invalid", () => {
  // Another kernel's clock.
  assert.equal(privilegedAfterLoss(log([{ ev: "accept", t: 2_000, conn: 1 }], { boot: "ffffffff-0000-4000-8000-000000000000" }), opts).result, "INVALID");
  // Two server instances in the window (a restart, or another run's server).
  assert.equal(privilegedAfterLoss(log([{ ev: "accept", t: 2_000, conn: 1, inst: "bbbb0002" }]), opts).result, "INVALID");
  // A duplicated event.
  const lines = log([{ ev: "accept", t: 2_000, conn: 1 }]);
  assert.equal(privilegedAfterLoss([...lines, lines.find((l) => l.includes('"accept"'))], opts).result, "INVALID");
  // A gap in the sequence (an event lost).
  assert.equal(privilegedAfterLoss(lines.filter((_, i) => i !== 5), opts).result, "INVALID");
});

test("traffic within the clock uncertainty of the limit is not decidable", () => {
  assert.equal(privilegedAfterLoss(log([{ ev: "accept", t: 2_000, conn: 1 }, { ev: "data", t: 20_001, conn: 1 }]), opts).result, "INVALID");
});

test("the real lab server logs accept, data and heartbeats, never the bytes it received", async () => {
  const fixtures = fileURLToPath(new URL("../fixtures.mjs", import.meta.url));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [fixtures, "serve", "ext:test", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  try {
    await new Promise((r) => setTimeout(r, 400));
    await new Promise((resolve, reject) => {
      const s = connect(port, "127.0.0.1", () => s.write("secret-token-123\n"));
      s.on("data", () => s.end());
      s.on("close", resolve);
      s.on("error", reject);
    });
    await new Promise((r) => setTimeout(r, 1300));
  } finally { child.kill(); }
  const events = out.trim().split("\n").map((l) => JSON.parse(l));
  for (const ev of ["start", "accept", "data", "close", "heartbeat"]) assert.ok(events.some((e) => e.ev === ev), `no ${ev} event`);
  assert.ok(!out.includes("secret-token-123"), "the server logged what it received");
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
  assert.equal(new Set(events.map((e) => e.inst)).size, 1);
  assert.equal(events.find((e) => e.ev === "data").bytes, "secret-token-123\n".length);
});
