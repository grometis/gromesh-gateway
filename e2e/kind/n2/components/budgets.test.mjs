// node --test e2e/kind/n2/components/budgets.test.mjs — the readings of K, Ks and Kx without a cluster: they validate
// the instrumentation, never the lab's real budgets.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { bootToWall, groupFromEvents, itemResult, keepaliveBlocked, kxFromEvents, rfc3339CeilMs, supervisorEvents, kFromLiveness, ksFromDeletion, LIMITS_MS, overall, runExitCode, verdict } from "./budgets.mjs";

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

test("milestones on disagreeing clocks are invalid, not fast", () => {
  assert.equal(verdict("Kx", { exercised: true, valueMs: -100, kind: "upperBound", resolutionMs: 1 }).result, "INVALID");
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
  const ev = (phase, ms) => `kill-event v=1 sup=s run=1 pid=9 pgid=9 boottimeNs=${ms * 1_000_000} phase=${phase} path=drain signal=SIGKILL`;
  assert.notEqual(kxFromEvents([ev("attempt", 18_000), ev("sent", 18_001), "exit-event v=1 sup=s run=1 pid=9 pgid=9 boottimeNs=18700000000 status=signal-killed"], "drain").result, "PASS");
  assert.equal(kxFromEvents(["exit-event v=1 sup=s run=1 pid=9 pgid=9 boottimeNs=3000000000 status=exit-0"], "drain").result, "NOT_EXERCISED");
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

// Lines as kubectl logs --timestamps shows them (the runtime's own timestamp first; never used for Kx).
const T = "2026-10-29T10:00:00.000000000Z ";
const kill = (phase, ns, { sup = "a1b2c3d4", run = 1, pid = 42, path = "containment", extra = "" } = {}) =>
  `${T}kill-event v=1 sup=${sup} run=${run} pid=${pid} pgid=${pid} boottimeNs=${ns} phase=${phase} path=${path} signal=SIGKILL${extra}`;
const exited = (ns, { sup = "a1b2c3d4", run = 1, pid = 42 } = {}) => `${T}exit-event v=1 sup=${sup} run=${run} pid=${pid} pgid=${pid} boottimeNs=${ns} status=signal-killed`;
const MS = 1_000_000n;

test("Kx events: the line format is the supervisor's own", () => {
  const go = readFileSync(new URL("../../../../apps/isolation/internal/supervisor/supervisor.go", import.meta.url), "utf8");
  assert.ok(go.includes('"%s v=1 sup=%s run=%d pid=%d pgid=%d boottimeNs=%s %s"'));
  assert.ok(go.includes('"exit-event v=1 sup=%s run=%d pid=%d pgid=%d boottimeNs=%s status=%s"'));
  assert.ok(go.includes('"phase=attempt path="+path+" signal=SIGKILL"'));
  assert.deepEqual(supervisorEvents([kill("attempt", 5)])[0], { kind: "kill-event", sup: "a1b2c3d4", run: "1", pid: "42", pgid: "42", boottimeNs: "5", phase: "attempt", path: "containment", signal: "SIGKILL" });
});

test("Kx events: SIGKILL sent and the same run's exit confirmed bound Kx", () => {
  const r = kxFromEvents([kill("attempt", 1000n * MS), kill("sent", 1000n * MS + 50_000n), exited(1120n * MS)], "containment");
  assert.equal(r.result, "PASS");
  assert.equal(r.valueMs, 120);
  assert.equal(r.kind, "upperBound");
  assert.deepEqual(r.identity, { sup: "a1b2c3d4", run: "1", pid: "42", pgid: "42" });
  // Above 0.5 s it is a bound above the limit: unknown, never a failure.
  assert.equal(kxFromEvents([kill("attempt", 1000n * MS), kill("sent", 1001n * MS), exited(1700n * MS)], "containment").result, "INVALID");
});

test("Kx events: no SIGKILL (graceful drain, or SIGTERM sufficed) is not exercised", () => {
  assert.equal(kxFromEvents([`${T}stop signal: draining nginx for at most 18s`, exited(9n * MS)], "drain").result, "NOT_EXERCISED");
  // A containment SIGKILL says nothing about the drain path, and the other way round.
  assert.equal(kxFromEvents([kill("attempt", 1n * MS), kill("sent", 2n * MS), exited(3n * MS)], "drain").result, "NOT_EXERCISED");
});

test("Kx events: a group already gone (ESRCH) is not exercised; any other refusal is invalid", () => {
  assert.equal(kxFromEvents([exited(900n * MS), kill("attempt", 1000n * MS), kill("failed", 1000n * MS + 1n, { extra: " error=ESRCH" })], "containment").result, "NOT_EXERCISED");
  const eperm = kxFromEvents([kill("attempt", 1000n * MS), kill("failed", 1000n * MS + 1n, { extra: " error=EPERM" }), exited(1100n * MS)], "containment");
  assert.equal(eperm.result, "INVALID");
  assert.match(eperm.reason, /EPERM/);
});

test("Kx events: missing or incomplete evidence is invalid, never a pass", () => {
  // Attempt without its result.
  assert.equal(kxFromEvents([kill("attempt", 1000n * MS), exited(1100n * MS)], "containment").result, "INVALID");
  // Sent without any confirmed exit.
  assert.equal(kxFromEvents([kill("attempt", 1000n * MS), kill("sent", 1001n * MS)], "containment").result, "INVALID");
  // The clock could not be read.
  assert.equal(kxFromEvents([kill("attempt", "unknown"), kill("sent", 1001n * MS), exited(1100n * MS)], "containment").result, "INVALID");
  assert.equal(kxFromEvents([kill("attempt", 1000n * MS), kill("sent", 1001n * MS), exited("unknown")], "containment").result, "INVALID");
});

test("Kx events: events of different runs never pair", () => {
  const attempt = kill("attempt", 1000n * MS), sent = kill("sent", 1001n * MS);
  // Another start of nginx (run 2), another supervisor process (sup), another pid: none confirms run 1's exit.
  for (const other of [exited(1100n * MS, { run: 2 }), exited(1100n * MS, { sup: "ffffffff" }), exited(1100n * MS, { pid: 43 })]) {
    assert.equal(kxFromEvents([attempt, sent, other], "containment").result, "INVALID");
  }
  // An earlier exit of the same run identity, before the SIGKILL, is not its confirmation.
  assert.equal(kxFromEvents([exited(900n * MS), attempt, sent], "containment").result, "INVALID");
  // A result of another run does not complete this attempt.
  assert.equal(kxFromEvents([attempt, kill("sent", 1001n * MS, { run: 2 }), exited(1100n * MS)], "containment").result, "INVALID");
});

test("Kx events: every attempt of the path is read, the worst stands (review r1)", () => {
  const run = (n, at, exitAfterMs, extra = "") => [kill("attempt", at, { run: n }), kill(extra ? "failed" : "sent", at + 1n, { run: n, extra }), ...(exitAfterMs == null ? [] : [exited(at + BigInt(exitAfterMs) * MS, { run: n })])];
  // 100 ms, then 700 ms: the second is above the limit, so not a pass.
  assert.equal(kxFromEvents([...run(1, 1000n * MS, 100), ...run(2, 5000n * MS, 700)], "containment").result, "INVALID");
  // 100 ms, then a refused SIGKILL: invalid.
  assert.equal(kxFromEvents([...run(1, 1000n * MS, 100), ...run(2, 5000n * MS, null, " error=EPERM")], "containment").result, "INVALID");
  // A group already gone first, then a real 120 ms kill: the real one is read.
  const later = kxFromEvents([...run(1, 1000n * MS, null, " error=ESRCH"), ...run(2, 5000n * MS, 120)], "containment");
  assert.equal(later.result, "PASS");
  assert.equal(later.attempts, 2);
  // Only ESRCH: not exercised.
  assert.equal(kxFromEvents(run(1, 1000n * MS, null, " error=ESRCH"), "containment").result, "NOT_EXERCISED");
});

test("Kx events: an event without its whole identity, another pgid or an unknown phase never completes an attempt (review r1)", () => {
  const strip = (line) => line.replace(/ sup=\S+ run=\S+ pid=\S+ pgid=\S+/, "");
  // No identity at all on every line: nothing pairs.
  assert.equal(kxFromEvents([kill("attempt", 1000n * MS), kill("sent", 1001n * MS), exited(1100n * MS)].map(strip), "containment").result, "INVALID");
  // The exit of another process group.
  assert.equal(kxFromEvents([kill("attempt", 1000n * MS), kill("sent", 1001n * MS), exited(1100n * MS).replace("pgid=42", "pgid=77")], "containment").result, "INVALID");
  // A phase that is neither sent nor failed is no result.
  assert.equal(kxFromEvents([kill("attempt", 1000n * MS), kill("queued", 1001n * MS), exited(1100n * MS)], "containment").result, "INVALID");
  // The group cleanup's SIGKILL (path=group) is never a Kx milestone.
  assert.equal(kxFromEvents([kill("attempt", 1000n * MS, { path: "group" }), kill("sent", 1001n * MS, { path: "group" }), exited(1100n * MS)], "containment").result, "NOT_EXERCISED");
});

test("Kx events: a result completes only its own attempt, never one before another attempt of its run (review r2)", () => {
  // attempt@1000, attempt@1100, sent@1101, exit@1120: the first attempt has no result of its own.
  const lines = [kill("attempt", 1000n * MS), kill("attempt", 1100n * MS), kill("sent", 1101n * MS), exited(1120n * MS)];
  assert.equal(kxFromEvents(lines, "containment").result, "INVALID");
  // Preceded by another run's ESRCH: still invalid, never a pass.
  assert.equal(kxFromEvents([kill("attempt", 500n * MS, { run: 9 }), kill("failed", 501n * MS, { run: 9, extra: " error=ESRCH" }), ...lines], "containment").result, "INVALID");
});

const g = (atMs, phase, extra = "", id = "sup=a1b2c3d4 run=1 pid=0 pgid=42 boottimeNs=9") => ({ atMs, text: `group-event v=1 ${id} phase=${phase} kills=3 repeats=${extra || "sent:2"}` });
const x = (atMs, id = "sup=a1b2c3d4 run=1 pid=42 pgid=42 boottimeNs=8") => ({ atMs, text: `exit-event v=1 ${id} status=signal-killed` });

test("the whole group after the master: gone in time passes, remaining or late fails, unmatched is invalid (review r1)", () => {
  const ok = groupFromEvents([x(19_000), g(19_500, "gone")], 20_000);
  assert.equal(ok.result, "PASS");
  assert.equal(ok.kills, 3);
  // Master at 19.9 s, group only at 20.2 s: late.
  assert.equal(groupFromEvents([x(19_900), g(20_200, "gone")], 20_000).result, "FAIL");
  assert.equal(groupFromEvents([x(1_000), g(1_100, "remaining", "EPERM:2")], 20_000).result, "FAIL");
  assert.equal(groupFromEvents([x(1_000), g(1_100, "remaining", "EPERM:2"), g(1_500, "gone")], 20_000).result, "FAIL");
  // Without identity or clock, or of another run than the stop's exit: not this stop's group.
  assert.equal(groupFromEvents([x(1_000), { atMs: 1_100, text: "group-event v=1 phase=gone kills=1 repeats=none" }], 20_000).result, "INVALID");
  assert.equal(groupFromEvents([x(1_000), g(1_100, "gone", "", "sup=a1b2c3d4 run=2 pid=0 pgid=42 boottimeNs=9")], 20_000).result, "INVALID");
  assert.equal(groupFromEvents([x(1_000), g(1_100, "gone", "", "sup=a1b2c3d4 run=1 pid=0 pgid=42 boottimeNs=unknown")], 20_000).result, "INVALID");
  assert.equal(groupFromEvents([g(1_100, "gone")], 20_000).result, "INVALID");
});

test("keepalive after the loss: only a 503 on a reused socket proves the block (review r1)", () => {
  const ka = (t, s, reused = true) => ({ k: "ka", t, reused, ...(s === "err" ? { e: "ECONNRESET" } : { s }) });
  assert.equal(keepaliveBlocked([ka(1_000, 200), ka(18_500, 503)], 19_000).result, "PASS");
  // A 500, or a reset followed by a 200, is no block.
  assert.equal(keepaliveBlocked([ka(1_000, 200), ka(18_000, 500)], 19_000).result, "NOT_EXERCISED");
  assert.equal(keepaliveBlocked([ka(1_000, "err"), ka(1_300, 200, false), ka(2_000, 200)], 19_000).result, "NOT_EXERCISED");
  // A 503 on a fresh socket is not the keepalive connection.
  assert.equal(keepaliveBlocked([ka(1_000, 200), ka(18_500, 503, false)], 19_000).result, "NOT_EXERCISED");
  // Kong stopped before the guard answered the keepalive socket: not proven, never a pass.
  assert.equal(keepaliveBlocked([ka(1_000, 200), ka(19_800, "err")], 19_000).result, "NOT_EXERCISED");
  // Negative controls: a 200 after 19 s, a reused 503 too late, no keepalive at all.
  assert.equal(keepaliveBlocked([ka(19_500, 200), ka(19_600, 503)], 19_000).result, "FAIL");
  assert.equal(keepaliveBlocked([ka(1_000, 200), ka(19_200, 503)], 19_000).result, "FAIL");
  assert.equal(keepaliveBlocked([{ k: "new", t: 1_000, s: 503 }], 19_000).result, "INVALID");
});

test("an RFC 3339 instant with nanoseconds rounds up: 24.000999999 s is never within 24 s (review r1)", () => {
  const base = Date.parse("2026-10-29T10:00:00Z");
  assert.equal(rfc3339CeilMs("2026-10-29T10:00:24.000999999Z") - base, 24_001);
  assert.equal(rfc3339CeilMs("2026-10-29T10:00:24.000000000Z") - base, 24_000);
  assert.equal(rfc3339CeilMs("2026-10-29T10:00:24Z") - base, 24_000);
  assert.equal(rfc3339CeilMs("2026-10-29T10:00:24.5Z") - base, 24_500);
  assert.equal(rfc3339CeilMs("0001-01-01T00:00:00Z") < 0, true);
  assert.equal(rfc3339CeilMs("not a time"), null);
});
