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

/**
 * K through the liveness (supervisor frozen). The liveness failure itself is not observed: it happens at or after the
 * detection, and the container can only finish after the signal, the effective grace G and the exit. So
 * finished − detection − G is an upper bound of K, never a value; the old finished − detection − Lp − Lt − G could
 * understate K by up to Lp + Lt.
 */
export function kFromLiveness({ detectionMs, kongFinishedMs, finishedResolutionMs, graceMs = 2000 }) {
  const exercised = detectionMs != null;
  const valueMs = exercised && kongFinishedMs != null ? kongFinishedMs - detectionMs - graceMs : null;
  return verdict("K", { exercised, valueMs, kind: "upperBound", resolutionMs: finishedResolutionMs, from: "violation detected (≤ liveness failure)", to: "kong container finished − G" });
}

/** Ks in a deletion: the delete call starts before the kubelet can observe it, so signal − call start bounds Ks. */
export function ksFromDeletion({ deleteCallStartMs, signalReceivedMs, resolutionMs = 1 }) {
  const valueMs = signalReceivedMs == null ? null : signalReceivedMs - deleteCallStartMs;
  return verdict("Ks", { exercised: true, valueMs, kind: "upperBound", resolutionMs, from: "delete call started (≤ kubelet observes the deletion)", to: "supervisor logged the stop signal" });
}

/** Kx only exists when the supervisor sent SIGKILL (drain exceeded); with a graceful exit it is not exercised. */
export function kxFromDrain({ sigkillMs, exitedMs, resolutionMs = 1 }) {
  return verdict("Kx", { exercised: sigkillMs != null, valueMs: sigkillMs != null && exitedMs != null ? exitedMs - sigkillMs : null, kind: "exact", resolutionMs,
    from: "supervisor logged SIGKILL (drain exceeded)", to: "supervisor logged nginx exited (waitpid)", reason: sigkillMs == null ? "nginx drained before Dk: no SIGKILL, Kx not exercised" : null });
}
