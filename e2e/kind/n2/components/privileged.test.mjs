// node --test e2e/kind/n2/components/privileged.test.mjs — the privileged destination's connection log, without a lab.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { privilegedAfterLoss } from "./privileged.mjs";

const BOOT = "7d2c1e9a-0b4f-4f0e-9d3a-1c2b3a4d5e6f";
const LOSS = 1_000_000;
const POD = "10.244.1.7", PROBE_ELSEWHERE = "10.244.2.9";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const ROUTE = "GET /ws-a/api HTTP/1.1", WS = "GET /ws-a/api/ws HTTP/1.1";
const opts = { server: "ext:imds", scenario: "run1-n", lossMs: LOSS, limitMs: 20_000, refBootId: BOOT, sources: [POD], requests: [sha(ROUTE), sha(WS)] };

/**
 * A server log: start, marks at −2 s and +25 s, heartbeats every second, then the given events (t relative to the
 * loss). The monotonic clock follows the wall clock unless `step` says from when the wall clock jumps by how much.
 */
function log(events, { inst = "aaaa0001", boot = BOOT, endAt = 25_000, beatsUntil = 25_000, skipBeats = [], step = null, marks = true } = {}) {
  const all = [{ ev: "start", t: -5_000, ports: [80] }];
  if (marks) all.push({ ev: "accept", t: -2_000, conn: 900, remote: "127.0.0.1" }, { ev: "mark", t: -2_000, conn: 900, scenario: "run1-n", phase: "start" });
  for (let t = -1_000; t <= beatsUntil; t += 1000) if (!skipBeats.includes(t)) all.push({ ev: "heartbeat", t });
  all.push(...events);
  if (marks) all.push({ ev: "accept", t: endAt, conn: 901, remote: "127.0.0.1" }, { ev: "mark", t: endAt, conn: 901, scenario: "run1-n", phase: "end" });
  all.sort((a, b) => a.t - b.t);
  return all.map((e, i) => {
    const wall = LOSS + e.t + (step && e.t >= step.at ? step.by : 0);
    const { t, ...rest } = e;
    const fields = e.ev === "accept" ? { local: "172.18.0.70", localPort: 80, remotePort: 40000 + (e.conn ?? 0) } : {};
    return JSON.stringify({ server: "ext:imds", inst: e.inst ?? inst, seq: e.seq ?? i + 1, boot: e.boot ?? boot, wallMs: wall, monoNs: String(BigInt(LOSS + t + 5_000_000) * 1_000_000n), ...fields, ...rest });
  });
}
const conn = (n, t, { remote = POD, line = ROUTE, reqAt = t + 50 } = {}) => [{ ev: "accept", t, conn: n, remote }, { ev: "req", t: reqAt, conn: n, req: 1, lineSha256: sha(line) }];

test("scenario requests after the loss that stop by the limit pass", () => {
  const r = privilegedAfterLoss(log([...conn(1, 2_000), ...conn(2, 15_000)]), opts);
  assert.equal(r.result, "PASS", r.reason);
  assert.equal(r.connections, 2);
});

test("negative controls: a new connection after 20 s, or a request on a persistent one, fails", () => {
  assert.equal(privilegedAfterLoss(log([...conn(1, 2_000), ...conn(2, 21_000)]), opts).result, "FAIL");
  const persistent = privilegedAfterLoss(log([...conn(1, 2_000, { reqAt: 22_000 })]), opts);
  assert.equal(persistent.result, "FAIL");
  assert.match(persistent.reason, /persistent connection/);
});

test("every flow of the scenario counts: a new WebSocket connection after the limit fails (review r2)", () => {
  assert.equal(privilegedAfterLoss(log([...conn(1, 2_000), ...conn(2, 21_000, { line: WS })]), opts).result, "FAIL");
});

test("the log must be the expected server's: another server's events are invalid (review r2)", () => {
  assert.equal(privilegedAfterLoss(log(conn(1, 2_000)).map((l) => l.replace('"server":"ext:imds"', '"server":"ext:backend"')), opts).result, "INVALID");
});

test("only the scenario counts: another source, another request or another server never exercises it (review P1)", () => {
  // The probe (or anything else) reaching the server after the loss, while the route still goes to the backend.
  assert.equal(privilegedAfterLoss(log(conn(1, 2_000, { remote: PROBE_ELSEWHERE })), opts).result, "NOT_EXERCISED");
  assert.equal(privilegedAfterLoss(log(conn(1, 2_000, { line: "probe-token-1234" })), opts).result, "NOT_EXERCISED");
  // A late connection that is not the scenario's is not its failure either.
  assert.equal(privilegedAfterLoss(log([...conn(1, 2_000), ...conn(2, 21_000, { line: "probe-token-1234" })]), opts).result, "PASS");
  // Nothing at all: never a pass.
  assert.equal(privilegedAfterLoss(log([]), opts).result, "NOT_EXERCISED");
});

test("the observation must be bracketed and alive to its end: no marks, a log cut short, a dead server (review P1)", () => {
  assert.equal(privilegedAfterLoss([], opts).result, "INVALID");
  assert.equal(privilegedAfterLoss(log(conn(1, 2_000), { marks: false }), opts).result, "INVALID");
  // Log cut at 19 s: no end mark.
  assert.equal(privilegedAfterLoss(log(conn(1, 2_000)).filter((l) => !l.includes('"phase":"end"') && JSON.parse(l).wallMs <= LOSS + 19_000), opts).result, "INVALID");
  // End mark before the limit.
  assert.equal(privilegedAfterLoss(log(conn(1, 2_000), { endAt: 19_000, beatsUntil: 19_000 }), opts).result, "INVALID");
  // The server stopped beating at 10 s (and a late connection could not have been seen).
  assert.equal(privilegedAfterLoss(log(conn(1, 2_000), { beatsUntil: 10_000 }), opts).result, "INVALID");
});

test("a stepped wall clock is invalid, never a shifted pass (review P1)", () => {
  // The wall clock steps back 10 s at 15 s: a request at 21 s real would read 11 s.
  assert.equal(privilegedAfterLoss(log([...conn(1, 2_000), ...conn(2, 21_000)], { step: { at: 15_000, by: -10_000 } }), opts).result, "INVALID");
});

test("malformed events, orphan requests, duplicates, gaps, another kernel or mixed instances are invalid (review P1)", () => {
  const lines = log([...conn(1, 2_000), ...conn(2, 25_500)]);
  // wallMs as a string on the late request.
  assert.equal(privilegedAfterLoss(lines.map((l) => (l.includes('"conn":2,"req"') ? l.replace(/"wallMs":\d+/, '"wallMs":"x"') : l)), opts).result, "INVALID");
  // A request of a connection never accepted.
  assert.equal(privilegedAfterLoss(log([{ ev: "req", t: 3_000, conn: 7, req: 1, lineSha256: sha(ROUTE) }]), opts).result, "INVALID");
  const ok = log(conn(1, 2_000));
  assert.equal(privilegedAfterLoss([...ok, ok[5]], opts).result, "INVALID");
  assert.equal(privilegedAfterLoss(ok.filter((_, i) => i !== 6), opts).result, "INVALID");
  assert.equal(privilegedAfterLoss(log(conn(1, 2_000), { boot: "ffffffff-0000-4000-8000-000000000000" }), opts).result, "INVALID");
  // The end mark of another instance (a restart in between): not one bracket.
  assert.equal(privilegedAfterLoss(log(conn(1, 2_000)).map((l) => (l.includes('"phase":"end"') ? l.replace('"inst":"aaaa0001"', '"inst":"cccc0003"') : l)), opts).result, "INVALID");
});

test("a scenario request within the clock uncertainty of the limit is not decidable", () => {
  assert.equal(privilegedAfterLoss(log(conn(1, 2_000, { reqAt: 20_001 })), opts).result, "INVALID");
});

test("the real lab server logs accept (both ends), the request's hash and marks, never the line it received", async () => {
  const fixtures = fileURLToPath(new URL("../fixtures.mjs", import.meta.url));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [fixtures, "serve", "ext:test", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  const send = (line) => new Promise((resolve, reject) => {
    const s = connect(port, "127.0.0.1", () => s.write(`${line}\n`));
    s.on("data", () => s.end());
    s.on("close", resolve);
    s.on("error", reject);
  });
  try {
    await new Promise((r) => setTimeout(r, 400));
    await send("MARK t-1 start");
    await send("GET /secret-token-123 HTTP/1.1");
    await send("MARK t-1 end");
    await new Promise((r) => setTimeout(r, 1300));
  } finally { child.kill(); }
  const events = out.trim().split("\n").map((l) => JSON.parse(l));
  for (const ev of ["start", "accept", "req", "mark", "close", "heartbeat"]) assert.ok(events.some((e) => e.ev === ev), `no ${ev} event`);
  assert.ok(!out.includes("secret-token-123"), "the server logged what it received");
  assert.equal(events.find((e) => e.ev === "req").lineSha256, sha("GET /secret-token-123 HTTP/1.1"));
  assert.deepEqual(events.filter((e) => e.ev === "mark").map((e) => `${e.scenario}:${e.phase}`), ["t-1:start", "t-1:end"]);
  const accept = events.find((e) => e.ev === "accept");
  assert.ok(accept.local && accept.localPort === port && accept.remote, JSON.stringify(accept));
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
});
