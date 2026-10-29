// node --test e2e/kind/n2/components/budgets.test.mjs — the readings of K, Ks and Kx without a cluster: they validate
// the instrumentation, never the lab's real budgets.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bootToWall, itemResult, kFromLiveness, ksFromDeletion, kxFromDrain, LIMITS_MS, overall, runExitCode, verdict } from "./budgets.mjs";

test("the limits are B §3.5.3's: K 2 s, Ks 1 s, Kx 0.5 s", () => {
  assert.deepEqual(LIMITS_MS, { K: 2000, Ks: 1000, Kx: 500 });
});

test("a missing measurement is never a pass", () => {
  assert.equal(verdict("Kx", { exercised: true, valueMs: null, kind: "exact", resolutionMs: 1 }).result, "INVALID");
  assert.equal(verdict("K", { exercised: true, valueMs: NaN, kind: "upperBound", resolutionMs: 1 }).result, "INVALID");
  assert.equal(verdict("Ks", { exercised: false, kind: "upperBound", resolutionMs: 1, to: "signal" }).result, "NOT_EXERCISED");
  assert.equal(overall([]), "NOT_EXERCISED");
});

test("negative control: a violation of each limit is detected on an exact measurement", () => {
  assert.equal(verdict("K", { exercised: true, valueMs: 2100, kind: "exact", resolutionMs: 1 }).result, "FAIL");
  assert.equal(verdict("Ks", { exercised: true, valueMs: 1300, kind: "exact", resolutionMs: 1 }).result, "FAIL");
  assert.equal(verdict("Kx", { exercised: true, valueMs: 700, kind: "exact", resolutionMs: 1 }).result, "FAIL");
});

test("a second of resolution cannot prove 0.5 s, nor any of these limits", () => {
  const r = verdict("Kx", { exercised: true, valueMs: 0, kind: "exact", resolutionMs: 1000 });
  assert.equal(r.result, "INVALID");
  assert.match(r.reason, /too coarse/);
  assert.equal(kFromLiveness({ detectionMs: 10_000, heartbeatMs: 10_000, kongFinishedMs: 12_500, finishedResolutionMs: 1000 }).result, "INVALID");
});

test("an upper bound passes below the limit and is inconclusive above it, never a failure", () => {
  assert.equal(ksFromDeletion({ deleteCallStartMs: 0, signalReceivedMs: 400 }).result, "PASS");
  const high = ksFromDeletion({ deleteCallStartMs: 0, signalReceivedMs: 1400 });
  assert.equal(high.result, "INVALID");
  assert.match(high.reason, /true value is not known/);
});

test("an exact value within the resolution of the limit is neither pass nor fail", () => {
  assert.equal(verdict("Kx", { exercised: true, valueMs: 495, kind: "exact", resolutionMs: 10 }).result, "INVALID");
});

test("Kx between the supervisor's lines is an upper bound: it passes below 0.5 s and never fails above", () => {
  // "drain exceeded" is logged before the SIGKILL syscall and "exited" after waitpid: the lines bracket Kx.
  assert.equal(kxFromDrain({ sigkillMs: 18_000, exitedMs: 18_400 }).result, "PASS");
  const slowLog = kxFromDrain({ sigkillMs: 18_000, exitedMs: 18_620 });
  assert.equal(slowLog.kind, "upperBound");
  assert.equal(slowLog.result, "INVALID");
});

test("milestones on disagreeing clocks are invalid, not fast", () => {
  assert.equal(kxFromDrain({ sigkillMs: 18_000, exitedMs: 17_900 }).result, "INVALID");
});

test("K: the heartbeat measured, not assumed, bounds the earliest liveness failure (review counterexamples)", () => {
  // r1: heartbeat stale from 3 s, detection 5 s, signal 6 s, finished 8 s; real K = 3 s. Detection alone said 1 s.
  assert.equal(kFromLiveness({ detectionMs: 5_000, heartbeatMs: 0, kongFinishedMs: 8_000, finishedResolutionMs: 1 }).result, "INVALID");
  // r2: last heartbeat 0.5 s (the freeze at 3 s says nothing about it), liveness fails 3.6 s, signal 6.1 s, finished
  // 8.1 s, detection 7 s; real K = 2.5 s. Assuming freeze − S + 3 s gave 1.1 s (PASS); the measured heartbeat gives
  // 8.1 − 2 − 3.5 = 2.6 s ≥ 2.5 s, above 2 s: not known.
  const r2 = kFromLiveness({ detectionMs: 7_000, heartbeatMs: 500, kongFinishedMs: 8_100, finishedResolutionMs: 1 });
  assert.equal(r2.valueMs, 2_600);
  assert.equal(r2.result, "INVALID");
  // Heartbeat at 0.5 s, finished 7.2 s: K ≤ 7.2 − 2 − 3.5 = 1.7 s whichever cause fired.
  assert.equal(kFromLiveness({ detectionMs: 7_000, heartbeatMs: 500, kongFinishedMs: 7_200, finishedResolutionMs: 1 }).result, "PASS");
  // The heartbeat not read: invalid, even with every other milestone.
  assert.equal(kFromLiveness({ detectionMs: 7_000, heartbeatMs: null, kongFinishedMs: 8_100, finishedResolutionMs: 1 }).result, "INVALID");
});

test("K through the liveness is an upper bound that excludes only G, never Lp and Lt", () => {
  // Heartbeat far back would allow anything: here the detection is the earlier cause (heartbeat + 3 s = 13 s > 10 s).
  const ok = kFromLiveness({ detectionMs: 10_000, heartbeatMs: 10_000, kongFinishedMs: 13_500, finishedResolutionMs: 1 });
  assert.equal(ok.result, "PASS");
  assert.equal(ok.valueMs, 1500);
  assert.equal(ok.kind, "upperBound");
  assert.equal(kFromLiveness({ detectionMs: 10_000, heartbeatMs: 10_000, kongFinishedMs: 15_000, finishedResolutionMs: 1 }).result, "INVALID");
  assert.equal(kFromLiveness({ detectionMs: 10_000, heartbeatMs: 10_000, kongFinishedMs: null, finishedResolutionMs: 1 }).result, "INVALID");
  // 10 ms of /proc/uptime is fine for 2 s; a 1 s finishedAt is not.
  assert.equal(kFromLiveness({ detectionMs: 10_000, heartbeatMs: 10_000, kongFinishedMs: 12_500, finishedResolutionMs: 1000 }).result, "INVALID");
});

test("a drain without SIGKILL leaves Kx not exercised; SIGKILL without a confirmed exit is invalid", () => {
  assert.equal(kxFromDrain({ sigkillMs: null, exitedMs: 3_000 }).result, "NOT_EXERCISED");
  assert.equal(kxFromDrain({ sigkillMs: 18_000, exitedMs: null }).result, "INVALID");
});

test("overall: FAIL dominates, then INVALID, then NOT_EXERCISED", () => {
  const pass = { result: "PASS" }, fail = { result: "FAIL" }, invalid = { result: "INVALID" }, idle = { result: "NOT_EXERCISED" };
  assert.equal(overall([pass, invalid, fail]), "FAIL");
  assert.equal(overall([pass, idle, invalid]), "INVALID");
  assert.equal(overall([pass, idle]), "NOT_EXERCISED");
  assert.equal(overall([pass, pass]), "PASS");
});

test("regression: the readings v2.mjs used before let violations through", () => {
  // Ks: `sig.at - t0 <= 1000 + (t0b - t0)` added the delete call's own duration to the limit: a 600 ms call let a
  // 1.5 s bound pass. The bound alone cannot pass it.
  const formerKs = (sigMs, t0, t0b) => sigMs - t0 <= 1000 + (t0b - t0);
  assert.equal(formerKs(1500, 0, 600), true);
  assert.notEqual(ksFromDeletion({ deleteCallStartMs: 0, signalReceivedMs: 1500 }).result, "PASS");
  // Kx: `kill && exited ? exited.at - kill.at : null` with no assertion: 700 ms and "never measured" both went by.
  const formerKx = (kill, exited) => (kill != null && exited != null ? exited - kill : null);
  assert.equal(formerKx(18_000, 18_700), 700);
  assert.equal(formerKx(null, 3_000), null);
  assert.notEqual(kxFromDrain({ sigkillMs: 18_000, exitedMs: 18_700 }).result, "PASS");
  assert.equal(kxFromDrain({ sigkillMs: null, exitedMs: 3_000 }).result, "NOT_EXERCISED");
  // K: `finished - detection - Lp - Lt - G` from the pod status (1 s finishedAt), recorded and never asserted: 3 s of
  // real slack read as 1 s.
  const formerK = (finishedMs, detectionMs) => finishedMs - detectionMs - 1000 - 1000 - 2000;
  assert.equal(formerK(15_000, 10_000), 1000);
  assert.notEqual(kFromLiveness({ detectionMs: 10_000, heartbeatMs: 10_000, kongFinishedMs: 15_000, finishedResolutionMs: 1 }).result, "PASS");
  assert.equal(kFromLiveness({ detectionMs: 10_000, heartbeatMs: 10_000, kongFinishedMs: 13_000, finishedResolutionMs: 1000 }).result, "INVALID");
});

test("an item with a reading not exercised is incomplete, and the run exits 2, never 0", () => {
  assert.equal(itemResult({ failures: [], open: ["Kx: nginx drained before Dk"] }), "incomplete");
  assert.equal(itemResult({ failures: ["Ks INVALID"], open: ["Kx"] }), "fail");
  assert.equal(itemResult({ failures: [], open: [] }), "pass");
  assert.equal(runExitCode([{ result: "pass" }, { result: "incomplete" }]), 2);
  assert.equal(runExitCode([{ result: "incomplete" }, { result: "fail" }]), 1);
  assert.equal(runExitCode([{ result: "pending" }]), 1);
  assert.equal(runExitCode([{ result: "pass" }], true), 1);
  assert.equal(runExitCode([{ result: "pass" }]), 0);
});

test("the heartbeat's wall instant carries the whole uncertainty of the clock reads (review r3 counterexample)", () => {
  // Boot and wall clocks equal here. Heartbeat at 500 ms; uptime read at 3000 ms; the second date 200 ms later.
  // Converting with the later date alone put the heartbeat at 700 ms and K at 1910 ms (PASS) for a real K of 2100 ms.
  const hb = bootToWall({ bootMs: 500, uptimeMs: 3000, wallBeforeMs: 3000, wallAfterMs: 3200 });
  assert.deepEqual(hb, { earliestMs: 490, spanMs: 210 });
  const k = kFromLiveness({ detectionMs: 7000, heartbeatMs: hb.earliestMs, heartbeatResolutionMs: hb.spanMs, kongFinishedMs: 7610, finishedResolutionMs: 1 });
  assert.equal(k.result, "INVALID");
  assert.ok(k.valueMs >= 2100);
  // A tight bracket (2 ms) keeps the reading usable: earliest = 1000 − (3000 + 10 − 500) = −1510, span 12 ms; Kong
  // finished at 4490 ms gives K ≤ 4490 − 2000 − 1490 = 1000 ms.
  const tight = bootToWall({ bootMs: 500, uptimeMs: 3000, wallBeforeMs: 1000, wallAfterMs: 1002 });
  assert.deepEqual(tight, { earliestMs: -1510, spanMs: 12 });
  assert.equal(kFromLiveness({ detectionMs: 7000, heartbeatMs: tight.earliestMs, heartbeatResolutionMs: tight.spanMs, kongFinishedMs: 4490, finishedResolutionMs: 1 }).result, "PASS");
  // Inconsistent reads are refused, never mapped.
  assert.equal(bootToWall({ bootMs: 500, uptimeMs: 3000, wallBeforeMs: 3200, wallAfterMs: 3000 }), null);
  assert.equal(bootToWall({ bootMs: 4000, uptimeMs: 3000, wallBeforeMs: 3000, wallAfterMs: 3001 }), null);
  assert.equal(bootToWall({ bootMs: NaN, uptimeMs: 3000, wallBeforeMs: 3000, wallAfterMs: 3001 }), null);
});
