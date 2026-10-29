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

/** kong-liveness fails on a supervisor heartbeat older than 3 s; the supervisor renews it every S = 1 s. */
export const HEARTBEAT_MAX_AGE_MS = 3000;
export const SUPERVISOR_PERIOD_MS = 1000;

/**
 * K through the liveness (supervisor frozen). The liveness failure itself is not observed. It cannot happen before the
 * earlier of two causes: nginx without a valid lease (at or after the violation's detection) and a stale heartbeat
 * (at or after frozen − S + 3 s, the last heartbeat being at most S before the freeze). The container finishes only
 * after the signal, the effective grace G and the exit. So finished − G − that earliest possible failure is an upper
 * bound of K, never a value; the old finished − detection − Lp − Lt − G could understate K by up to Lp + Lt, and
 * ignored that the heartbeat may fail first.
 */
export function kFromLiveness({ detectionMs, frozenMs, kongFinishedMs, finishedResolutionMs, graceMs = 2000 }) {
  const exercised = detectionMs != null || frozenMs != null;
  const causes = [detectionMs, frozenMs == null ? null : frozenMs - SUPERVISOR_PERIOD_MS + HEARTBEAT_MAX_AGE_MS].filter((v) => v != null);
  const earliestFailure = causes.length ? Math.min(...causes) : null;
  const valueMs = earliestFailure != null && kongFinishedMs != null ? kongFinishedMs - graceMs - earliestFailure : null;
  return verdict("K", { exercised, valueMs, kind: "upperBound", resolutionMs: finishedResolutionMs,
    from: "earliest possible liveness failure: min(violation detected, supervisor frozen − S + 3 s)", to: "kong container finished − G" });
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
