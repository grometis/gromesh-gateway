// node --test e2e/kind/n2/components/budgets.test.mjs — the readings of K, Ks and Kx without a cluster: they validate
// the instrumentation, never the lab's real budgets.
import assert from "node:assert/strict";
import { test } from "node:test";
import { itemResult, kFromLiveness, ksFromDeletion, kxFromDrain, LIMITS_MS, overall, runExitCode, verdict } from "./budgets.mjs";

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
  assert.equal(kFromLiveness({ detectionMs: 10_000, kongFinishedMs: 12_500, finishedResolutionMs: 1000 }).result, "INVALID");
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

test("K: a heartbeat that fails before the detection is the earliest liveness failure (review counterexample)", () => {
  // Frozen at 1 s: the heartbeat is stale from 1 − S + 3 = 3 s; detection at 5 s; signal at 6 s; finished at 8 s.
  // Real K = 6 − 3 = 3 s. From the detection alone the bound would be 8 − 5 − 2 = 1 s (a false PASS).
  assert.equal(kFromLiveness({ detectionMs: 5_000, kongFinishedMs: 8_000, finishedResolutionMs: 1 }).result, "PASS");
  const r = kFromLiveness({ detectionMs: 5_000, frozenMs: 1_000, kongFinishedMs: 8_000, finishedResolutionMs: 1 });
  assert.equal(r.valueMs, 3_000);
  assert.equal(r.result, "INVALID");
  // Frozen long before (heartbeat earliest at 3 s), finished 6.5 s: K ≤ 1.5 s whichever cause fired.
  assert.equal(kFromLiveness({ detectionMs: 5_000, frozenMs: 1_000, kongFinishedMs: 6_500, finishedResolutionMs: 1 }).result, "PASS");
});

test("K through the liveness is an upper bound that excludes only G, never Lp and Lt", () => {
  // Detection at 10 s, Kong finished at 13.5 s (nanoseconds from crictl): K ≤ 1.5 s.
  const ok = kFromLiveness({ detectionMs: 10_000, kongFinishedMs: 13_500, finishedResolutionMs: 1 });
  assert.equal(ok.result, "PASS");
  assert.equal(ok.valueMs, 1500);
  // The former reading (− Lp − Lt as well) gave 13.5 − 10 − 4 = −0.5 s here; this one says 1.5 s and is a bound.
  assert.equal(ok.kind, "upperBound");
  // Finished 15 s: bound 3 s > 2 s, so K is not known; a frozen supervisor that never stopped Kong is invalid.
  assert.equal(kFromLiveness({ detectionMs: 10_000, kongFinishedMs: 15_000, finishedResolutionMs: 1 }).result, "INVALID");
  assert.equal(kFromLiveness({ detectionMs: 10_000, kongFinishedMs: null, finishedResolutionMs: 1 }).result, "INVALID");
  assert.equal(kFromLiveness({ detectionMs: null, kongFinishedMs: null, finishedResolutionMs: 1 }).result, "NOT_EXERCISED");
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
  assert.notEqual(kFromLiveness({ detectionMs: 10_000, kongFinishedMs: 15_000, finishedResolutionMs: 1 }).result, "PASS");
  assert.equal(kFromLiveness({ detectionMs: 10_000, kongFinishedMs: 13_000, finishedResolutionMs: 1000 }).result, "INVALID");
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
