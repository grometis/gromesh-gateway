// The N2 hypotheses K, Ks and Kx of B §3.5.3 (measured in N2, never assumed): their limits, their milestones and the
// reading of a measurement. A missing, coarse or merely bounded measurement is never a pass.
//   K  (kubelet and runtime slack): from the liveness failure to the signal reaching the process        ≤ 2 s
//   Ks (deletion observed by the kubelet → stop signal received by the supervisor)                      ≤ 1 s
//   Kx (SIGKILL sent by the supervisor → nginx's exit confirmed by waitpid)                              ≤ 0.5 s
export const LIMITS_MS = { K: 2000, Ks: 1000, Kx: 500 };
export const RESULTS = ["PASS", "FAIL", "NOT_EXERCISED", "INVALID"];

/**
 * Reads one measurement against its limit. `kind`: "exact" (both milestones observed) or "upperBound" (an earlier
 * milestone stands in for the real start, so the true value is at most valueMs). `resolutionMs`: the coarsest clock or
 * sampling behind the two milestones; above a tenth of the limit the measurement cannot speak to the limit.
 */
export function verdict(name, { exercised, valueMs = null, kind, resolutionMs = null, from, to, reason = null, identity }) {
  const limitMs = LIMITS_MS[name];
  if (limitMs === undefined) throw new Error(`unknown budget ${name}`);
  const base = { name, unit: "ms", limitMs, valueMs, kind, resolutionMs, from, to, ...(identity ? { identity } : {}) };
  if (!exercised) return { ...base, result: "NOT_EXERCISED", reason: reason ?? `${to} did not happen` };
  if (typeof valueMs !== "number" || !Number.isFinite(valueMs)) return { ...base, result: "INVALID", reason: reason ?? `exercised but ${from} → ${to} was not measured` };
  if (valueMs < 0) return { ...base, result: "INVALID", reason: `negative interval ${valueMs} ms: milestones on clocks that do not agree` };
  if (typeof resolutionMs !== "number" || resolutionMs < 0 || resolutionMs > limitMs / 10) {
    return { ...base, result: "INVALID", reason: `resolution ${resolutionMs} ms is too coarse for a ${limitMs} ms limit` };
  }
  if (kind !== "exact" && kind !== "upperBound") throw new Error(`unknown measurement kind ${kind}`);
  if (valueMs + resolutionMs <= limitMs) return { ...base, result: "PASS", reason: null };
  if (kind === "exact" && valueMs - resolutionMs > limitMs) return { ...base, result: "FAIL", reason: `${valueMs} ms > ${limitMs} ms` };
  return { ...base, result: "INVALID", reason: kind === "exact"
    ? `${valueMs} ms is within the resolution of the ${limitMs} ms limit`
    : `upper bound ${valueMs} ms above ${limitMs} ms: the true value is not known` };
}

/** The worst of several readings: FAIL, then INVALID, then NOT_EXERCISED; PASS only when every reading passed. */
export function overall(verdicts) {
  if (verdicts.length === 0) return "NOT_EXERCISED";
  for (const r of ["FAIL", "INVALID", "NOT_EXERCISED"]) if (verdicts.some((v) => v.result === r)) return r;
  return "PASS";
}

/** kong-liveness fails on a supervisor heartbeat older than 3 s (CLOCK_BOOTTIME). */
export const HEARTBEAT_MAX_AGE_MS = 3000;
/** /proc/uptime (CLOCK_BOOTTIME) is truncated to hundredths of a second. */
export const UPTIME_RESOLUTION_MS = 10;

/**
 * A CLOCK_BOOTTIME instant on the wall clock, from `date` read before and after /proc/uptime on the same kernel: the
 * uptime was read at some wall instant t in [before, after] and the boot clock then was in [uptime, uptime + 10 ms).
 * Returns the earliest wall instant the boot instant can be (the conservative side for an upper bound that subtracts
 * it) and the width of the whole uncertainty, used as the reading's resolution.
 */
export function bootToWall({ bootMs, uptimeMs, wallBeforeMs, wallAfterMs }) {
  if (![bootMs, uptimeMs, wallBeforeMs, wallAfterMs].every(Number.isFinite) || wallAfterMs < wallBeforeMs || bootMs > uptimeMs + UPTIME_RESOLUTION_MS) return null;
  return { earliestMs: wallBeforeMs - (uptimeMs + UPTIME_RESOLUTION_MS - bootMs), spanMs: wallAfterMs - wallBeforeMs + UPTIME_RESOLUTION_MS };
}

/**
 * K through the liveness (supervisor frozen). The liveness failure itself is not observed. It cannot happen before the
 * earlier of two causes: nginx without a valid lease (after the violation's detection) and a stale heartbeat (more
 * than 3 s after the supervisor's last heartbeat, read from kong-state.json after the freeze, so no later one exists).
 * The container finishes only after the signal, the effective grace G and the exit, so finished − G − that earliest
 * possible failure is an upper bound of K, never a value. The heartbeat is measured, never assumed from the freeze or
 * the ticker: without it the reading is invalid. The old finished − detection − Lp − Lt − G could understate K by up
 * to Lp + Lt and ignored that the heartbeat may fail first.
 */
export function kFromLiveness({ detectionMs, heartbeatMs, kongFinishedMs, finishedResolutionMs, heartbeatResolutionMs = UPTIME_RESOLUTION_MS, graceMs = 2000 }) {
  const base = { kind: "upperBound", resolutionMs: Math.max(finishedResolutionMs ?? Infinity, heartbeatResolutionMs),
    from: "earliest possible liveness failure: min(violation detected, last heartbeat + 3 s)", to: "kong container finished − G" };
  if (heartbeatMs == null) return verdict("K", { ...base, exercised: true, valueMs: null, reason: "the supervisor's last heartbeat was not read: its age is not proven" });
  const earliestFailure = Math.min(heartbeatMs + HEARTBEAT_MAX_AGE_MS, detectionMs ?? Infinity);
  return verdict("K", { ...base, exercised: true, valueMs: kongFinishedMs == null ? null : kongFinishedMs - graceMs - earliestFailure });
}

/** Ks in a deletion: the delete call starts before the kubelet can observe it, so signal − call start bounds Ks. */
export function ksFromDeletion({ deleteCallStartMs, signalReceivedMs, resolutionMs = 1 }) {
  const valueMs = signalReceivedMs == null ? null : signalReceivedMs - deleteCallStartMs;
  return verdict("Ks", { exercised: true, valueMs, kind: "upperBound", resolutionMs, from: "delete call started (≤ kubelet observes the deletion)", to: "supervisor logged the stop signal" });
}

/** An item's result: a failure fails it; otherwise a reading not exercised leaves it incomplete, never a pass. */
export const itemResult = ({ failures, open }) => (failures.length ? "fail" : open.length ? "incomplete" : "pass");
/** The run's exit code read by the external runner: 1 for a failure, 2 for an incomplete item, 0 only when all passed. */
export const runExitCode = (items, otherFailure = false) =>
  otherFailure || items.some((i) => i.result === "fail" || i.result === "pending") ? 1 : items.some((i) => i.result === "incomplete") ? 2 : 0;

/** The supervisor's milestone lines ("kill-event …", "exit-event …", key=value; supervisor.go) as objects. */
export function supervisorEvents(lines) {
  const events = [];
  for (const line of lines) {
    const m = /\b(kill-event|exit-event|start-event) v=1 (.*)$/.exec(line);
    if (!m) continue;
    const e = { kind: m[1] };
    for (const kv of m[2].trim().split(/\s+/)) { const i = kv.indexOf("="); if (i > 0) e[kv.slice(0, i)] = kv.slice(i + 1); }
    events.push(e);
  }
  return events;
}

/**
 * Kx of one stop path ("drain" or "containment") from the supervisor's own milestones: CLOCK_BOOTTIME read before
 * kill(2) (attempt) and right after Wait4 reaped the same run of nginx (exit), so exit − attempt bounds Kx from above.
 * Only events of one run (sup, run, pid) pair. No attempt: not exercised; a SIGKILL refused because the group was
 * already gone (ESRCH): not exercised either; any other refusal, an attempt without its result, a sent SIGKILL
 * without a confirmed exit of that run, or an unknown clock: invalid.
 */
export function kxFromEvents(lines, path) {
  const events = supervisorEvents(lines);
  const sameRun = (a, b) => a.sup === b.sup && a.run === b.run && a.pid === b.pid;
  const ns = (e) => (e && /^\d+$/.test(e.boottimeNs) ? BigInt(e.boottimeNs) : null);
  const base = { kind: "upperBound", resolutionMs: 1, from: `kill-event phase=attempt path=${path} (≤ SIGKILL sent)`, to: "exit-event of the same run (≥ waitpid confirmed)" };
  const attempts = events.filter((e) => e.kind === "kill-event" && e.phase === "attempt" && e.path === path && e.signal === "SIGKILL");
  if (attempts.length === 0) return verdict("Kx", { ...base, exercised: false, reason: `no SIGKILL on the ${path} path` });
  const attempt = attempts[0];
  const result = events.find((e) => e.kind === "kill-event" && e.phase !== "attempt" && e.path === path && sameRun(e, attempt) && ns(e) !== null && ns(attempt) !== null && ns(e) >= ns(attempt));
  if (result?.phase === "failed" && result.error === "ESRCH") return verdict("Kx", { ...base, exercised: false, reason: "the process group was gone before SIGKILL (ESRCH)" });
  if (result?.phase === "failed") return verdict("Kx", { ...base, exercised: true, valueMs: null, reason: `SIGKILL refused: ${result.error}` });
  if (!result) return verdict("Kx", { ...base, exercised: true, valueMs: null, reason: "SIGKILL attempted without its result (or on an unknown clock)" });
  const exit = events.find((e) => e.kind === "exit-event" && sameRun(e, attempt) && ns(e) !== null && ns(e) >= ns(result));
  if (!exit) return verdict("Kx", { ...base, exercised: true, valueMs: null, reason: "SIGKILL sent without a confirmed exit of that run" });
  return verdict("Kx", { ...base, exercised: true, valueMs: Number(ns(exit) - ns(attempt)) / 1e6, identity: { sup: attempt.sup, run: attempt.run, pid: attempt.pid } });
}
