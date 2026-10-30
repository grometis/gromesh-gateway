// "No connection to the privileged destination after the containment limit" (B §3.5.3, aceite n), read from the lab
// server's own connection log (fixtures.mjs serve): importable without a lab (privileged.test.mjs).

/** Date.now on both sides (the server and the suite's reference read on a lab node), 1 ms each. */
export const CLOCK_RESOLUTION_MS = 2;
/** The largest drift of (wall − monotonic) tolerated inside a scenario before the wall clock counts as stepped. */
export const MAX_CLOCK_SPREAD_MS = 5;

const isInt = (v) => Number.isInteger(v) && v >= 0;
const isText = (v) => typeof v === "string" && v.length > 0;
const SHAPES = {
  start: (e) => Array.isArray(e.ports),
  heartbeat: () => true,
  accept: (e) => isInt(e.conn) && isText(e.local) && isText(e.remote) && isInt(e.localPort) && isInt(e.remotePort),
  req: (e) => isInt(e.conn) && isInt(e.req) && /^[0-9a-f]{64}$/.test(e.lineSha256 ?? ""),
  mark: (e) => isInt(e.conn) && isText(e.scenario) && (e.phase === "start" || e.phase === "end"),
  close: (e) => isInt(e.conn),
};
const wellFormed = (e) => SHAPES[e.ev] !== undefined && isText(e.server) && /^[0-9a-f]{8}$/.test(e.inst ?? "") && isInt(e.seq) && e.seq > 0 &&
  isText(e.boot) && Number.isFinite(e.wallMs) && /^\d+$/.test(e.monoNs ?? "") && SHAPES[e.ev](e);

/**
 * lines: the server's stdout (every event must name `server`). scenario: the id the suite marked ("MARK <scenario> start" before the loss, "end" after
 * the window). lossMs: the earliest instant the isolation can have been lost (read before the policy was removed), on
 * the reference clock of a lab node whose boot id is refBootId. A connection is the scenario's only when it comes from
 * one of `sources` (the contained pods' addresses) and carries a request whose first line hashes to one of `requests`
 * (SHA-256 of each first line the scenario's clients send: HTTP, keepalive and WebSocket alike): a probe's or anyone
 * else's connection never counts.
 *   INVALID        any malformed event, a request of a connection never accepted, a duplicated or missing seq, another
 *                  kernel (boot id), a wall clock that stepped (wall − mono spread > 5 ms), the scenario not bracketed
 *                  by its marks in one instance, a start mark after lossMs or an end mark before lossMs + limitMs, a
 *                  heartbeat gap > 2 × heartbeatMs between the marks, or a scenario request within the clock
 *                  uncertainty of the limit;
 *   FAIL           a scenario request after lossMs + limitMs + the uncertainty;
 *   NOT_EXERCISED  no scenario request after the loss (the route never reached the destination): never a pass;
 *   PASS           scenario requests after the loss, none after the limit.
 */
export function privilegedAfterLoss(lines, { server, scenario, lossMs, limitMs, refBootId, sources, requests, heartbeatMs = 1000 }) {
  const base = { name: "privileged", unit: "ms", limitMs, from: "isolation lost (earliest)", to: "last scenario request at the privileged destination" };
  const invalid = (reason) => ({ ...base, result: "INVALID", reason });
  const events = [];
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    if (!wellFormed(e)) return invalid(`malformed server event: ${JSON.stringify(e).slice(0, 120)}`);
    if (e.server !== server) return invalid(`an event of server ${e.server} in the log of ${server}`);
    events.push(e);
  }
  const marks = events.filter((e) => e.ev === "mark" && e.scenario === scenario);
  const start = marks.filter((m) => m.phase === "start"), end = marks.filter((m) => m.phase === "end");
  if (start.length !== 1 || end.length !== 1) return invalid(`scenario ${scenario} not bracketed by exactly one start and one end mark`);
  if (start[0].inst !== end[0].inst || start[0].seq > end[0].seq) return invalid("the scenario's marks are of two server instances, or out of order");
  const inst = start[0].inst;
  const all = events.filter((e) => e.inst === inst);
  const seqs = all.map((e) => e.seq);
  if (new Set(seqs).size !== seqs.length) return invalid("duplicated server events (same instance and seq)");
  const sorted = [...seqs].sort((a, b) => a - b);
  if (sorted[0] !== 1 || sorted.some((s, i) => i > 0 && s !== sorted[i - 1] + 1)) return invalid("a gap in the server's event sequence (events lost)");
  if (all.some((e) => e.boot !== refBootId)) return invalid("server events on another kernel (boot id): no clock correlation with the loss");
  const inside = all.filter((e) => e.seq >= start[0].seq && e.seq <= end[0].seq);
  const offsets = inside.map((e) => e.wallMs - Number(BigInt(e.monoNs) / 1_000_000n));
  const spread = Math.max(...offsets) - Math.min(...offsets);
  if (spread > MAX_CLOCK_SPREAD_MS) return invalid(`the server's wall clock moved ${spread} ms against its monotonic clock during the scenario`);
  const uncertainty = spread + CLOCK_RESOLUTION_MS;
  const deadline = lossMs + limitMs;
  if (start[0].wallMs > lossMs) return invalid("the start mark is after the loss: the observation does not cover it");
  if (end[0].wallMs < deadline + uncertainty) return invalid("the end mark is before the limit: the observation stopped too early");
  const beats = [start[0], ...inside.filter((e) => e.ev === "heartbeat"), end[0]].map((e) => e.wallMs).sort((a, b) => a - b);
  const gap = Math.max(...beats.slice(1).map((t, i) => t - beats[i]));
  if (gap > 2 * heartbeatMs) return invalid(`heartbeat gap ${gap} ms > ${2 * heartbeatMs} ms between the marks: the observer was not proven alive`);
  const accepts = new Map(all.filter((e) => e.ev === "accept").map((e) => [e.conn, e]));
  // A dual-stack listener reports an IPv4 peer as ::ffff:a.b.c.d: one form for both sides of the comparison.
  const own = new Set(sources.map(plainAddress));
  const fromScenario = (e) => e.ev === "req" && requests.includes(e.lineSha256) && own.has(plainAddress(accepts.get(e.conn).remote));
  for (const r of inside.filter((e) => e.ev === "req")) if (!accepts.has(r.conn)) return invalid(`request on connection ${r.conn} that was never accepted`);
  // Reached before the loss: the barrier was not in place, so nothing after it measures the containment.
  const early = inside.find((e) => fromScenario(e) && e.wallMs < lossMs);
  if (early) return invalid(`a scenario request reached the privileged destination ${lossMs - early.wallMs} ms before the loss`);
  const scenarioReqs = inside.filter((e) => fromScenario(e) && e.wallMs >= lossMs);
  const late = scenarioReqs.filter((e) => e.wallMs > deadline + uncertainty);
  if (late.length) {
    const r = late[0], acceptedAt = accepts.get(r.conn).wallMs;
    return { ...base, result: "FAIL", valueMs: r.wallMs - lossMs, uncertaintyMs: uncertainty,
      reason: acceptedAt > deadline ? `connection ${r.conn} accepted at ${acceptedAt - lossMs} ms > ${limitMs} ms` : `request on persistent connection ${r.conn} at ${r.wallMs - lossMs} ms > ${limitMs} ms` };
  }
  if (scenarioReqs.some((e) => Math.abs(e.wallMs - deadline) <= uncertainty)) return invalid(`a scenario request within ${uncertainty} ms of the limit: not decidable`);
  if (scenarioReqs.length === 0) return { ...base, result: "NOT_EXERCISED", uncertaintyMs: uncertainty, reason: "no scenario request reached the privileged destination after the loss" };
  return { ...base, result: "PASS", reason: null, uncertaintyMs: uncertainty, valueMs: Math.max(...scenarioReqs.map((e) => e.wallMs)) - lossMs,
    connections: new Set(scenarioReqs.map((e) => e.conn)).size, instance: inst };
}

const plainAddress = (a) => String(a ?? "").toLowerCase().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, "$1");

/**
 * The first request line of every flow a containment scenario sends through Kong for workspace `slug`: new and
 * keepalive HTTP on /api, the WebSocket upgrade on /api/ws, and the route that targets the privileged destination.
 */
export const scenarioRequestLines = (slug, privilegedPath) => [`GET /${slug}/api HTTP/1.1`, `GET /${slug}/api/ws HTTP/1.1`, `GET /${slug}${privilegedPath} HTTP/1.1`];

/**
 * How many scenario requests (from `sources`, with one of the `requests` hashes) the server logged between the
 * scenario's start and end marks; null when the log does not hold exactly one of each, in order, of one instance.
 */
export function privilegedRequestsBetween(lines, { server, scenario, sources, requests, heartbeatMs = 1000 }) {
  const events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.server === server);
  const start = events.filter((e) => e.ev === "mark" && e.scenario === scenario && e.phase === "start");
  const end = events.filter((e) => e.ev === "mark" && e.scenario === scenario && e.phase === "end");
  if (start.length !== 1 || end.length !== 1 || start[0].inst !== end[0].inst || start[0].seq > end[0].seq) return null;
  // Absence is evidence only on a complete log: every event of the instance, no gap, no orphan request.
  const all = events.filter((e) => e.inst === start[0].inst);
  const seqs = all.map((e) => e.seq).sort((a, b) => a - b);
  if (new Set(seqs).size !== seqs.length || seqs[0] !== 1 || seqs.some((s, i) => i > 0 && s !== seqs[i - 1] + 1)) return null;
  const inside = all.filter((e) => e.seq > start[0].seq && e.seq < end[0].seq);
  const accepts = new Map(all.filter((e) => e.ev === "accept").map((e) => [e.conn, e]));
  if (inside.some((e) => e.ev === "req" && !accepts.has(e.conn))) return null;
  // And the observer alive throughout: heartbeats at most two periods apart between the marks.
  const beats = [start[0], ...inside.filter((e) => e.ev === "heartbeat"), end[0]].map((e) => e.wallMs).sort((x, y) => x - y);
  if (beats.slice(1).some((t, i) => t - beats[i] > 2 * heartbeatMs)) return null;
  const own = new Set(sources.map(plainAddress));
  return inside.filter((e) => e.ev === "req" && requests.includes(e.lineSha256) && own.has(plainAddress(accepts.get(e.conn)?.remote))).length;
}
