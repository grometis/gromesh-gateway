// "No connection to the privileged destination after the containment limit" (B §3.5.3, aceite n), read from the lab
// server's own connection log (fixtures.mjs serve): importable without a lab (privileged.test.mjs).

/** Date.now on both sides (the server and the suite's reference read on a lab node), 1 ms each. */
export const CLOCK_UNCERTAINTY_MS = 2;

/**
 * lines: the server's stdout (JSON lines; anything else ignored). lossMs: the loss of isolation on the reference clock
 * (date +%s%3N on a lab node); refBootId: that node's boot id. Wall clocks are only comparable on one kernel, so every
 * event must carry refBootId; otherwise there is no correlation and the reading is INVALID. The observation must be
 * proven alive over [lossMs, lossMs + windowMs]: one server instance, gapless sequence, no duplicate, heartbeats never
 * more than 2 × heartbeatMs apart. Then:
 *   FAIL           a connection accepted, or a request received on any connection, after lossMs + limitMs;
 *   INVALID        an event within the clock uncertainty of the limit, or the observation not proven;
 *   NOT_EXERCISED  nothing reached the destination after the loss (the scenario never routed to it): never a pass;
 *   PASS           traffic reached it after the loss and stopped by the limit.
 */
export function privilegedAfterLoss(lines, { lossMs, limitMs, windowMs, refBootId, heartbeatMs = 1000 }) {
  const base = { name: "privileged", unit: "ms", limitMs, from: "isolation lost", to: "last connection or request at the privileged destination" };
  const events = [];
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e && typeof e === "object" && typeof e.ev === "string") events.push(e);
  }
  const end = lossMs + windowMs;
  const inWindow = events.filter((e) => typeof e.wallMs === "number" && e.wallMs >= lossMs && e.wallMs <= end);
  if (inWindow.length === 0) return { ...base, result: "INVALID", reason: "no server event during the window: the observer is down or its log was lost" };
  const instances = new Set(inWindow.map((e) => e.inst));
  if (instances.size !== 1) return { ...base, result: "INVALID", reason: `${instances.size} server instances in the window: restarted or mixed runs` };
  const [inst] = instances;
  const mine = events.filter((e) => e.inst === inst);
  const seqs = mine.map((e) => e.seq);
  if (new Set(seqs).size !== seqs.length) return { ...base, result: "INVALID", reason: "duplicated server events (same instance and seq)" };
  const sorted = [...seqs].sort((a, b) => a - b);
  if (sorted.some((s, i) => i > 0 && s !== sorted[i - 1] + 1)) return { ...base, result: "INVALID", reason: "a gap in the server's event sequence" };
  if (mine.some((e) => e.boot !== refBootId)) return { ...base, result: "INVALID", reason: "server events on another kernel (boot id): no clock correlation with the loss" };
  const beats = inWindow.filter((e) => e.ev === "heartbeat").map((e) => e.wallMs).sort((a, b) => a - b);
  const marks = [lossMs, ...beats, end];
  const gap = Math.max(...marks.slice(1).map((t, i) => t - marks[i]));
  if (gap > 2 * heartbeatMs) return { ...base, result: "INVALID", reason: `heartbeat gap ${gap} ms > ${2 * heartbeatMs} ms: the observer was not proven alive` };
  const traffic = inWindow.filter((e) => e.ev === "accept" || e.ev === "data");
  if (traffic.length === 0) return { ...base, result: "NOT_EXERCISED", reason: "nothing reached the privileged destination after the loss: the scenario did not route to it" };
  const deadline = lossMs + limitMs;
  const late = traffic.filter((e) => e.wallMs > deadline + CLOCK_UNCERTAINTY_MS);
  if (late.length) {
    const first = late[0];
    return { ...base, result: "FAIL", valueMs: first.wallMs - lossMs,
      reason: first.ev === "accept" ? `connection ${first.conn} accepted at ${first.wallMs - lossMs} ms > ${limitMs} ms` : `request on connection ${first.conn} at ${first.wallMs - lossMs} ms > ${limitMs} ms (a persistent connection still reaching it)` };
  }
  const edge = traffic.filter((e) => Math.abs(e.wallMs - deadline) <= CLOCK_UNCERTAINTY_MS);
  if (edge.length) return { ...base, result: "INVALID", reason: `traffic within ${CLOCK_UNCERTAINTY_MS} ms of the limit: not decidable` };
  const last = Math.max(...traffic.map((e) => e.wallMs));
  return { ...base, result: "PASS", reason: null, valueMs: last - lossMs, connections: new Set(traffic.map((e) => e.conn)).size, instance: inst };
}
