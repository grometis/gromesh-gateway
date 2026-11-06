import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { CLIENT } from "../components/client-script.mjs";
import { bootLeaseRejected, clockRollback, drainConverged, f3Unadopted, negativeReplay, nodeReboot, probeFailure, probeRestart, websocketClosed, windowOf } from "./scenario-checks.mjs";
import { probeFailureStreams } from "./kind-scenarios.mjs";
import { validateManifest } from "./host-events.mjs";

const start = 100_000, end = 150_000;
function stream(pod = "victim", finish = end + 6000) {
  const events = [];
  for (let t = start - 4000; t <= finish; t += 500) events.push({ t, requestedAt: t - 1, pod, observer: "observer", boot: "observer-boot", seq: events.length + 1, k: "new", s: t < start || pod === "survivor" ? 200 : 503 });
  return events;
}
const replace = (e, at, data) => Object.assign(e.find((x) => x.t === at), data);
const clone = structuredClone;

function ws() {
  const events = stream();
  replace(events, start - 1000, { k: "ws", ev: "pong", connection: "warm" });
  replace(events, start + 10_000, { k: "ws", ev: "close", connection: "warm" });
  replace(events, start + 21_000, { k: "ws", ev: "attempt", connection: "retry" });
  return { events, start, end, pod: "victim", limit: 20_000 };
}
function f3() {
  return { attempted: true, grant: 100, deleted: 110, fate: { state: "closed", closeReason: "kong-stop-confirmed", chain: [{ seq: 1, final: true, kongStopConfirmed: true }], closeAudit: { neverServed: true } }, replacement: { requested: 120, decided: 26_120 }, pendencies: [] };
}
function probe() {
  const events = stream();
  for (const e of stream("survivor")) events.push(e);
  events.sort((a, b) => a.t - b.t).forEach((e, i) => { e.seq = i + 1; });
  return { events, start, end, victim: "victim", survivor: "survivor", stopped: start + 35_000, exercised: true };
}
function f4() {
  const before = { t: start - 500, probe: "p1", kong: "k1", uid: "u1", boot: "b1", admission: "a1", seq: 5, ready: true, lease: true };
  const after = { ...before, t: end, probe: "p2", seq: 8 };
  const samples = [];
  for (let t = start; t <= end; t += 500) samples.push({ from: t, t, admission: "a1", seq: 6, final: false, lease: t > start + 30_000, leasePresent: t > start + 30_000, passes: t > start + 30_000 ? 2 : 1, proven: 7, ready: t > start + 31_000, guardVerified: t > start + 31_000 });
  const events = stream();
  replace(events, end, { s: 200 });
  return { before, after, samples, start, end, events, pod: "victim", reports: Array.from({ length: 8 }, (_, i) => ({ seq: i + 1, final: false, digest: `d${i + 1}`, prevDigest: i ? `d${i}` : null })) };
}
function drain() {
  return { removed: { name: "old", uid: "old-uid" }, replacement: { uid: "new-uid", admitted: true, ready: true, served: true, attempts: 4 }, exits: { kong: 1, agent: 2, "isolation-probe": 3, collector: 4 }, nodes: [{ node_id: "new", evidence: "verified", verified_revision: 3 }], states: [{ state: "converged" }], revision: 3, exercised: true };
}
function reboot() {
  const events = stream();
  replace(events, end + 1000, { s: 200 });
  return { before: { node: "vm1", machine: "m1", boot: "b1", uptime: 900_000, admission: "old", ready: true, proven: 7 }, after: { node: "vm1", machine: "m1", boot: "b2", uptime: 1000 },
    oldFinal: { admissionId: "old", bootId: "b1", final: true, finalReason: "node-reboot", kongStopConfirmed: true }, recovered: { admission: "new", boot: "b2", ready: true, served: true, proven: 7 }, survivor: { node: "vm2", boot: "independent", served: true }, exercised: true, start, end, events, survivorEvents: stream("survivor") };
}
function boot() {
  return { events: stream(), start, end, pod: "victim", actualBoot: "b1", forgedBoot: "b2", lease: { bootId: "b2", expiresBoottimeNs: 1e12, nowNs: 1e9 }, exercised: true };
}
function clock() {
  const samples = [];
  for (let t = start; t <= end; t += 500) samples.push({ t, mono: t - start + 1000, boot: "b1", observerBefore: t - 1, observerAfter: t + 1 });
  return { before: { boot: "b1", mono: 1000, wall: 2e6 }, after: { boot: "b1", mono: 1001, wall: 2e6 - 120_000 }, samples, leaseExpires: 34_000, events: stream(), start, end, pod: "victim", exercised: true };
}

// Every gate has positive, unsafe and unexercised evidence plus its anti-false-PASS replay. Values are independent of
// the implementation (not generated from the checker). All corruptions preserve unrelated identities/windows.
const cases = [
  ["F3-1", f3Unadopted, f3, (e) => { e.fate.chain[0].seq = 2; }, (e) => { e.fate.closeAudit.neverServed = false; }],
  ["WebSocket", websocketClosed, ws, (e) => replace(e.events, start + 20_500, { k: "ws", ev: "pong", connection: "reopened" }), (e) => { e.events = []; }],
  ["probe failure", probeFailure, probe, (e) => { e.stopped++; }, (e) => { e.exercised = false; }],
  ["F4", probeRestart, f4, (e) => { e.samples[3].final = true; }, (e) => { e.after.probe = e.before.probe; }],
  ["drain", drainConverged, drain, (e) => { e.nodes.push({ node_id: "old" }); }, (e) => { delete e.exits.collector; }],
  ["real reboot", nodeReboot, reboot, (e) => { e.oldFinal.kongStopConfirmed = false; }, (e) => { e.after.boot = e.before.boot; }],
  ["bootId", bootLeaseRejected, boot, (e) => replace(e.events, start + 2000, { s: 200 }), (e) => { e.lease.expiresBoottimeNs = e.lease.nowNs; }],
  ["clock rollback", clockRollback, clock, (e) => replace(e.events, start + 35_000, { s: 200 }), (e) => { e.after.wall = e.before.wall; }],
];
for (const [name, check, fixture, unsafe, missing] of cases) {
  test(`${name}: PASS only for complete exercised evidence`, () => assert.equal(check(fixture()).result, "PASS"));
  test(`${name}: unsafe behavior is FAIL`, () => { const e = fixture(); unsafe(e); assert.equal(check(e).result, "FAIL"); });
  test(`${name}: missing event/evidence is INVALID`, () => { const e = fixture(); missing(e); assert.equal(check(e).result, "INVALID"); });
  test(`${name}: negative evidence replay detects a false PASS`, () => assert.equal(negativeReplay(check, fixture(), unsafe).result, "PASS"));
  test(`${name}: ineffective negative control cannot pass`, () => assert.equal(negativeReplay(check, fixture(), () => {}).result, "FAIL"));
}

test("streams reject missing timestamps, seq gaps, observer reboot and truncated observation", () => {
  for (const corrupt of [
    (e) => { e[2].t = null; }, (e) => { e[2].seq++; }, (e) => { e[2].boot = "new"; },
    (e) => { e.splice(5, 10); }, (e) => { e.pop(); }, (e) => { e.shift(); },
  ]) { const e = stream(); corrupt(e); assert.equal(windowOf(e, start - 4000, end + 6000), false); }
});
test("F3 losing adoption race never passes even with a successful final and replacement", () => {
  const e = f3(); e.fate.chain.unshift({ seq: 1, final: false }); e.fate.chain[1].seq = 2;
  assert.equal(f3Unadopted(e).result, "INVALID");
});
test("F3 replacement deadline inclusive at 26 s; late/pending fails", () => {
  const e = f3(); e.replacement.decided++; assert.equal(f3Unadopted(e).result, "FAIL");
  e.replacement.decided--; e.pendencies.push({}); assert.equal(f3Unadopted(e).result, "FAIL");
});
test("WS first close does not hide a later upgrade, even a different connection", () => {
  const e = ws(); replace(e.events, start + 30_000, { k: "ws", ev: "open", connection: "second" });
  assert.equal(websocketClosed(e).result, "FAIL");
});
test("WS close of an unrelated socket does not close the warmed socket", () => {
  const e = ws(); e.events.find((e) => e.ev === "close").connection = "other";
  assert.equal(websocketClosed(e).result, "INVALID");
});
test("probe: 34/35/39 s bounds and late success on victim", () => {
  const e = probe(); e.independent = true; e.frozenNginx = true; e.independentFrozenAt = start + 30_000; e.stopped = start + 39_000;
  assert.equal(probeFailure(e).result, "PASS"); e.stopped++;
  assert.equal(probeFailure(e).result, "FAIL");
  e.stopped--; replace(e.events, start + 34_500, { pod: "victim", s: 200 });
  assert.equal(probeFailure(e).result, "FAIL");
});
test("probe cannot use traffic only on a healthy Service replica", () => {
  const e = probe(); e.events.forEach((x) => { if (x.pod === "victim") x.k = "heartbeat"; });
  assert.equal(probeFailure(e).result, "INVALID");
});
test("probe rejects one initial 503 followed by victim heartbeats", () => {
  const e = probe();
  e.events.forEach((x) => { if (x.pod === e.victim && x.t > start) x.k = "heartbeat"; });
  assert.equal(probeFailure(e).result, "INVALID");
});
test("probe requires distributed victim requests at both ends and throughout the window", () => {
  for (const missing of [
    (t) => t < start + 2500,
    (t) => t > end - 2500,
    (t) => t > start + 10_000 && t < start + 15_000,
  ]) {
    const e = probe();
    e.events.forEach((x) => { if (x.pod === e.victim && x.t >= start && x.t <= end && missing(x.t)) x.k = "heartbeat"; });
    assert.equal(probeFailure(e).result, "INVALID");
  }
  const e = probe();
  e.events.forEach((x) => { if (x.pod === e.victim && x.t > start + 35_000) { delete x.s; x.e = "ECONNREFUSED"; } });
  assert.equal(probeFailure(e).result, "PASS", "connection errors still exercise the stopped victim");
});
test("probe healthy replica interruption fails; missing traffic is INVALID", () => {
  const e = probe(); e.events.find((x) => x.pod === "survivor" && x.t > start).s = 503;
  assert.equal(probeFailure(e).result, "FAIL");
  e.events.forEach((x) => { if (x.pod === "survivor" && x.t > start) x.k = "heartbeat"; });
  assert.equal(probeFailure(e).result, "INVALID");
});
test("separate victim/survivor streams are validated before merging", () => {
  const e = { ...probe(), events: stream(), survivorEvents: stream("survivor") };
  assert.equal(probeFailureStreams(e).result, "PASS");
  e.survivorEvents[10].seq++;
  assert.equal(probeFailureStreams(e).result, "INVALID");
});
test("F4 rejects one proof, missing withdrawal, same container and premature Ready", () => {
  for (const [mutate, result] of [
    [(e) => e.samples.forEach((s) => { s.passes = 1; }), "FAIL"],
    [(e) => e.samples.forEach((s) => { s.lease = true; s.leasePresent = true; }), "INVALID"],
    [(e) => { e.after.kong = "new-kong"; }, "INVALID"],
    [(e) => e.samples.forEach((s) => { s.guardVerified = false; }), "FAIL"],
    [(e) => { e.samples[5].t += 3000; }, "INVALID"],
  ]) { const e = f4(); mutate(e); assert.equal(probeRestart(e).result, result); }
});
test("F4 rejects premature Ready in any sample before lease/proofs/canary recovery", () => {
  for (const [index, state] of [
    [0, {}], [8, {}],
    [8, { lease: true, guardVerified: true, passes: 1 }],
    [8, { lease: true, guardVerified: true, passes: 2, proven: 6 }],
    [8, { lease: false, guardVerified: true, passes: 2 }],
    [61, {}],
    [90, { guardVerified: false }],
  ]) {
    const e = f4();
    Object.assign(e.samples[index], state, { ready: true });
    assert.equal(probeRestart(e).result, "FAIL", `premature Ready at sample ${index}: ${JSON.stringify(state)}`);
  }
});
test("drain does not pass with missing sidecar times, empty nodes, SQL workaround or unchanged pod", () => {
  for (const mutate of [(e) => { delete e.exits.agent; }, (e) => { e.nodes = []; }, (e) => { e.mutated = true; }, (e) => { e.replacement.uid = e.removed.uid; }]) {
    const e = drain(); mutate(e); assert.equal(drainConverged(e).result, "INVALID");
  }
});
test("reboot requires old admission final, independent kernel, new admission and full traffic", () => {
  for (const [mutate, result] of [
    [(e) => { e.oldFinal = null; }, "INVALID"], [(e) => { e.survivor.boot = e.after.boot; }, "INVALID"],
    [(e) => { e.recovered.admission = e.before.admission; }, "FAIL"], [(e) => { e.events = []; }, "INVALID"],
  ]) { const e = reboot(); mutate(e); assert.equal(nodeReboot(e).result, result); }
});
test("clock cannot compare civil timestamps across a step or pass without reaching lease expiry", () => {
  const e = clock(); e.samples.forEach((s) => { s.mono = 1; });
  assert.equal(clockRollback(e).result, "INVALID");
  e.samples = clock().samples; e.after.mono = 0;
  assert.equal(clockRollback(e).result, "INVALID");
});
test("client contains sequenced heartbeat and per-connection events and compiles as ESM", () => {
  // Parse via vm's Script after dropping import declarations; no timers/network are executed.
  new Script(CLIENT.replace(/^import .*;$/m, ""));
  assert.match(CLIENT, /seq: \+\+seq/); assert.match(CLIENT, /k: "heartbeat"/); assert.match(CLIENT, /k: "ws", connection/);
});
test("B rejects implicit/unpinned environments and shared machine IDs", () => {
  assert.throws(() => validateManifest({}), /gromesh/);
  const m = { disposable: "gromesh-n2-environment-b", context: "b", namespace: "dp", cpNamespace: "cp", postgresPod: "pg", victimPod: "v", survivorPod: "s", clusterId: "11111111-1111-1111-1111-111111111111", systemNamespaceUid: "22222222-2222-2222-2222-222222222222", caSha256: "a".repeat(64), server: "https://127.0.0.1", nodes: [1, 2, 3].map((n) => ({ name: `vm${n}`, ssh: `lab@vm${n}`, machine: String(n).repeat(32) })), observer: { namespace: "obs", pod: "obs" }, knownHosts: "/tmp/known", trafficKeyFile: "/tmp/key", path: "/a/api", wsPath: "/a/api/ws", expectedImageIds: [`sha256:${"b".repeat(64)}`], revision: 1 };
  assert.equal(validateManifest(clone(m)).revision, 1);
  m.nodes[1].machine = m.nodes[0].machine;
  assert.throws(() => validateManifest(m), /independent/);
});
test("wrapper isolates B dispatch before host-check, kind, builds and cleanup", () => {
  const wrapper = readFileSync(new URL("./run-all.sh", import.meta.url), "utf8");
  assert.ok(wrapper.indexOf('== host-events') < wrapper.indexOf('bash "$here/host-check.sh"'));
  assert.match(wrapper, /lifecycle\) suite lifecycle/);
});
test("probe streams without victim events return INVALID rather than throwing", () => {
  assert.equal(probeFailureStreams({ ...probe(), events: [], survivorEvents: stream("survivor") }).result, "INVALID");
});
test("an expired lease before the clock step cannot exercise rollback protection", () => {
  const e = clock(); e.leaseExpires = e.after.mono;
  assert.equal(clockRollback(e).result, "INVALID");
});
test("F4 requires the CP chain from seq1, no final and continuous prevDigest", () => {
  for (const [mutate, expected] of [
    [(e) => { e.reports.shift(); }, "INVALID"],
    [(e) => { e.reports[4].final = true; }, "FAIL"],
    [(e) => { e.reports[4].prevDigest = "wrong"; }, "FAIL"],
  ]) { const e = f4(); mutate(e); assert.equal(probeRestart(e).result, expected); }
});
test("independent containment needs nginx alive when the supervisor freezes", () => {
  const e = probe(); e.independent = true; e.independentFrozenAt = start + 20_000; e.frozenNginx = false;
  assert.equal(probeFailure(e).result, "INVALID");
});
test("drain with no replacement traffic is INVALID even if Ready and converged", () => {
  const e = drain(); e.replacement.attempts = 0;
  assert.equal(drainConverged(e).result, "INVALID");
});
test("clock correlation uncertainty cannot hide a late success behind an SSH round trip", () => {
  const e = clock();
  for (const s of e.samples) { s.observerBefore = s.t - 100; s.observerAfter = s.t + 100; }
  replace(e.events, start + 34_000, { s: 200 });
  assert.equal(clockRollback(e).result, "INVALID");
  replace(e.events, start + 34_500, { s: 200 });
  assert.equal(clockRollback(e).result, "FAIL");
  for (const s of e.samples) { s.observerBefore -= 2000; s.observerAfter += 2000; }
  assert.equal(clockRollback(e).result, "INVALID");
});
test("F4 cannot pass when business traffic resumes during proof/canary recovery", () => {
  const e = f4(); replace(e.events, start + 5000, { s: 200 });
  assert.equal(probeRestart(e).result, "FAIL");
});
