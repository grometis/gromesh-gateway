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
export function verdict(name, { exercised, valueMs = null, kind, resolutionMs = null, from, to, reason = null }) {
  const limitMs = LIMITS_MS[name];
  if (limitMs === undefined) throw new Error(`unknown budget ${name}`);
  const base = { name, unit: "ms", limitMs, valueMs, kind, resolutionMs, from, to };
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

/**
 * Kx only exists when the supervisor sent SIGKILL (drain exceeded); with a graceful exit it is not exercised. The
 * supervisor logs "drain exceeded" before the SIGKILL syscall and "exited" after waitpid returned, so the interval
 * between the two lines bounds Kx from above: a pass below 0.5 s, never a failure above it.
 */
export function kxFromDrain({ sigkillMs, exitedMs, resolutionMs = 1 }) {
  return verdict("Kx", { exercised: sigkillMs != null, valueMs: sigkillMs != null && exitedMs != null ? exitedMs - sigkillMs : null, kind: "upperBound", resolutionMs,
    from: "supervisor logged drain exceeded (≤ SIGKILL sent)", to: "supervisor logged nginx exited (≥ waitpid confirmed)", reason: sigkillMs == null ? "nginx drained before Dk: no SIGKILL, Kx not exercised" : null });
}

/** An item's result: a failure fails it; otherwise a reading not exercised leaves it incomplete, never a pass. */
export const itemResult = ({ failures, open }) => (failures.length ? "fail" : open.length ? "incomplete" : "pass");
/** The run's exit code read by the external runner: 1 for a failure, 2 for an incomplete item, 0 only when all passed. */
export const runExitCode = (items, otherFailure = false) =>
  otherFailure || items.some((i) => i.result === "fail" || i.result === "pending") ? 1 : items.some((i) => i.result === "incomplete") ? 2 : 0;
