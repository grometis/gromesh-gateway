// External gates use observer time within a boot, never civil time across a deliberate clock step/reboot.
const reading = (result, reason, measures = {}) => ({ result, reason, ...measures });
const invalid = (why) => reading("INVALID", why);
const fail = (why) => reading("FAIL", why);
const pass = () => reading("PASS", null);
const finite = Number.isFinite;

// A stream must bracket the WHOLE requested window. Heartbeats keep a quiet/closed socket observable.
export function windowOf(events, start, end, gap = 2000) {
  if (!finite(start) || !finite(end) || end <= start || !Array.isArray(events) || !events.length) return false;
  if (events.some((e) => !finite(e.t) || !Number.isInteger(e.seq) || !e.observer || !e.boot)) return false;
  if (events.some((e) => ["new", "ka"].includes(e.k) && (!finite(e.requestedAt) || e.requestedAt > e.t))) return false;
  if (new Set(events.map((e) => `${e.observer}/${e.boot}`)).size !== 1) return false;
  for (let i = 1; i < events.length; i++) {
    if (events[i].seq !== events[i - 1].seq + 1 || events[i].t < events[i - 1].t || events[i].t - events[i - 1].t > gap) return false;
  }
  return events[0].t <= start && events.at(-1).t >= end;
}

export function websocketClosed({ events, start, end, limit = 20_000, pod }) {
  if (!pod || !windowOf(events, start - 2000, end) || end < start + limit + 5000) return invalid("unbracketed WebSocket window or missing pod identity");
  const ws = events.filter((e) => e.k === "ws");
  if (ws.some((e) => e.pod !== pod || !e.connection)) return invalid("WebSocket not bound to the selected pod/connection");
  const warm = ws.filter((e) => e.t < start && e.ev === "pong").at(-1);
  if (!warm) return invalid("no pong before the event");
  const after = ws.filter((e) => e.t >= start && e.t <= end);
  if (after.some((e) => e.t > start + limit && ["open", "pong"].includes(e.ev))) return fail("WebSocket opened/echoed after the containment deadline");
  const close = after.find((e) => e.connection === warm.connection && e.ev === "close");
  if (!close) return invalid("no close observed for the warmed connection");
  if (!after.some((e) => e.ev === "attempt" && e.t > start + limit)) return invalid("no WebSocket reconnect attempted after the deadline");
  return close.t <= start + limit ? pass() : fail("warmed WebSocket closed too late");
}

export function f3Unadopted({ fate, grant, deleted, replacement, pendencies, attempted }) {
  if (!attempted || !finite(grant) || !finite(deleted) || deleted < grant || !fate || !Array.isArray(fate.chain) || !Array.isArray(pendencies)) return invalid("missing grant/delete/chain/pendency evidence");
  // Losing the race is not an implementation failure, and especially not a successful F3-1.
  if (fate.chain.some((r) => !r.final) || fate.closeAudit?.neverServed !== true) return invalid("admission adopted; F3-1 was not exercised");
  if (fate.state !== "closed" || fate.closeReason !== "kong-stop-confirmed" || fate.chain.length !== 1 || fate.chain[0].seq !== 1 || !fate.chain[0].final || !fate.chain[0].kongStopConfirmed) return fail("not closed by exactly one confirmed final seq 1");
  if (!replacement || !finite(replacement.requested) || !finite(replacement.decided) || replacement.decided < replacement.requested) return invalid("replacement decision missing");
  return replacement.decided - replacement.requested > 26_000 || pendencies.length ? fail("replacement late or pendency left open") : pass();
}

export function probeFailure({ events, start, end, victim, survivor, stopped, independent = false, independentFrozenAt, frozenNginx, exercised }) {
  if (!exercised || !victim || !survivor || victim === survivor || !windowOf(events, start - 2000, end) || end < start + 45_000) return invalid("probe freeze or full per-pod traffic window missing");
  if (independent && (!frozenNginx || !finite(independentFrozenAt) || !finite(stopped) || stopped <= independentFrozenAt)) return invalid("independent stop path not exercised with nginx alive");
  for (const pod of [victim, survivor]) {
    if (!events.some((e) => e.pod === pod && e.k === "new" && e.s === 200 && e.t < start)) return invalid(`no warm traffic on ${pod}`);
  }
  const ev = events.filter((e) => e.t >= start && e.t <= end);
  const healthy = ev.filter((e) => e.pod === survivor && e.k === "new");
  if (healthy.length < 2 || healthy[0].t > start + 2000 || healthy.at(-1).t < end - 2000 || healthy.some((e, i) => i && e.t - healthy[i - 1].t > 2000)) return invalid("survivor traffic not continuous");
  if (healthy.some((e) => e.s !== 200)) return fail("healthy replica interrupted");
  const v = ev.filter((e) => e.pod === victim && e.k === "new");
  if (v.length < 2 || v[0].t > start + 2000 || v.at(-1).t < end - 2000 || v.some((e, i) => i && e.t - v[i - 1].t > 2000)) return invalid("victim traffic not continuous");
  if (v.some((e) => e.s === 200 && e.t > start + 34_000)) return fail("victim served after lease deadline");
  const blocked = v.find((e) => e.s === 503);
  if (!blocked || !finite(stopped)) return invalid("503 or identified Kong exit absent");
  return blocked.t > start + 34_000 || stopped > start + (independent ? 39_000 : 35_000) ? fail("probe failure containment late") : pass();
}

export function probeRestart({ before, samples, after, start, end, events, pod, reports }) {
  if (!before || !after || !Array.isArray(samples) || !samples.length || !windowOf(events, start - 2000, end) || end < start + 35_000) return invalid("restart/recovery observation incomplete");
  if (!before.ready || !before.lease) return invalid("probe restart did not begin on a serving pod with a valid lease");
  if (!before.probe || !after.probe || before.probe === after.probe || before.uid !== after.uid || before.boot !== after.boot || !before.kong || before.kong !== after.kong) return invalid("not a probe-only restart on the same pod/kernel/Kong");
  if (![before.seq, after.seq].every(Number.isInteger) || samples.some((s) => !finite(s.t) || !finite(s.from) || s.from > s.t || !Number.isInteger(s.seq))) return invalid("state/chain sampling missing");
  if (samples[0].t > start + 2000 || samples.at(-1).t < end - 2000) return invalid("state sampling does not cover the recovery window");
  if (!before.admission || before.admission !== after.admission || after.seq <= before.seq) return fail("admission/chain lost or reset");
  if (after.final || !after.ready || !after.lease) return fail("probe recovery did not remain Ready on the same chain");
  if (!Array.isArray(reports) || !reports.length || reports[0].seq !== 1 || reports.at(-1).seq < after.seq) return invalid("control plane did not observe the resumed report chain");
  if (reports.some((r, i) => r.final || (i && (r.seq !== reports[i - 1].seq + 1 || r.prevDigest !== reports[i - 1].digest)))) return fail("resumed report chain closed or discontinuous");
  if (samples.some((s, i) => i && (s.t < samples[i - 1].t || s.t - samples[i - 1].t > 2000))) return invalid("gap in lease/proof sampling");
  if (samples.some((s) => s.final || s.admission !== before.admission)) return fail("probe-only restart closed/replaced the admission");
  if (samples.some((s) => s.ready && (!s.lease || !(s.passes >= 2) || s.proven !== 7 || !s.guardVerified))) return fail("Ready before valid lease, two complete proofs and canary verification");
  const withdrawn = samples.find((s) => s.t >= start && s.leasePresent === false);
  if (!withdrawn) return invalid("lease withdrawal not observed");
  const renewed = samples.find((s) => s.t > withdrawn.t && s.lease);
  if (!renewed) return invalid("recovery lease never observed");
  if (renewed.passes < 2 || renewed.proven !== 7) return fail("lease issued before two complete proofs");
  const ready = samples.find((s) => s.t >= renewed.t && s.ready);
  if (!ready) return invalid("canary/Ready recovery not observed");
  if (!ready.guardVerified) return fail("Ready before canary verified");
  const verified = samples.find((s) => s.t >= renewed.t && s.guardVerified);
  if (!verified) return invalid("canary milestone absent");
  const premature = events.filter((e) => e.pod === pod && e.s === 200 && e.requestedAt > withdrawn.t + 1000 && e.t < verified.t);
  if (premature.some((e) => samples.some((s) => s.from >= e.t && s.t < verified.t && !s.guardVerified))) return fail("business traffic resumed before canary verification");
  if (premature.length) return invalid("business response overlaps the canary sampling interval");
  if (!events.some((e) => e.pod === pod && e.t < start && e.s === 200) || !events.some((e) => e.pod === pod && e.t >= ready.t && e.s === 200)) return invalid("no traffic before/after probe restart");
  return pass();
}

export function drainConverged({ removed, replacement, exits, nodes, states, revision, exercised, mutated = false }) {
  if (!exercised || !removed || !replacement || !Array.isArray(nodes) || !Array.isArray(states) || !Number.isInteger(revision)) return invalid("deletion/replacement/convergence evidence missing");
  if (mutated) return invalid("SQL/admin workaround invalidates natural reconvergence");
  if (["kong", "agent", "isolation-probe", "collector"].some((c) => !finite(exits?.[c]))) return invalid("sidecar finishedAt absent");
  if (["agent", "isolation-probe", "collector"].some((c) => exits[c] < exits.kong)) return fail("sidecar ended before Kong");
  if (replacement.uid === removed.uid) return invalid("no replacement pod");
  if (!Number.isInteger(replacement.attempts) || replacement.attempts <= 0) return invalid("no traffic to the replacement pod");
  if (!replacement.admitted || !replacement.ready || !replacement.served) return fail("replacement not admitted/Ready/serving");
  if (!states.length || !nodes.length) return invalid("empty convergence observation");
  return nodes.some((n) => n.node_id === removed.name) || nodes.some((n) => n.evidence !== "verified" || n.verified_revision !== revision) || states.at(-1).state !== "converged" ? fail("deployment did not naturally reconverge") : pass();
}

export function nodeReboot({ before, after, oldFinal, recovered, survivor, exercised, events, survivorEvents, start, end }) {
  if (!exercised || !before?.boot || !after?.boot || !finite(before.uptime) || !finite(after.uptime) || before.node !== after.node || before.machine !== after.machine || !before.machine) return invalid("host reboot identity/clock missing");
  if (before.boot === after.boot) return invalid("same boot: container restart is not a kernel reboot");
  if (!before.ready || before.proven !== 7) return invalid("reboot did not begin with a serving, proven replica");
  if (!windowOf(events, start - 2000, end + 5000) || !windowOf(survivorEvents, start - 2000, end)) return invalid("reboot traffic window incomplete");
  const healthy = survivorEvents.filter((e) => e.k === "new" && e.t >= start && e.t <= end);
  if (!healthy.length || healthy.at(-1).t < end - 2000 || healthy[0].t > start + 2000 || healthy.some((e, i) => i && e.t - healthy[i - 1].t > 2000)) return invalid("survivor traffic absent");
  if (healthy.some((e) => e.s !== 200)) return fail("independent replica stopped serving during reboot");
  if (!events.some((e) => e.k === "new" && e.s === 200 && e.t >= start - 2000 && e.t < start) || !events.some((e) => e.k === "new" && e.s === 200 && e.t >= end)) return invalid("no victim traffic before/after reboot");
  if (!oldFinal) return invalid("old-boot final report absent (persistent state required)");
  if (oldFinal.admissionId !== before.admission || oldFinal.bootId !== before.boot || oldFinal.finalReason !== "node-reboot" || !oldFinal.final || !oldFinal.kongStopConfirmed) return fail("old admission not closed with node-reboot proof");
  if (!recovered?.admission || recovered.admission === before.admission || recovered.boot !== after.boot || !recovered.ready || !recovered.served || recovered.proven !== 7) return fail("new boot served without a new admission/proof");
  if (!survivor?.served || survivor.boot === after.boot || survivor.node === after.node) return invalid("no serving replica on an independent kernel");
  return pass();
}

export function bootLeaseRejected({ events, start, end, pod, actualBoot, forgedBoot, lease, exercised }) {
  if (!exercised || !actualBoot || !forgedBoot || actualBoot === forgedBoot || lease?.bootId !== forgedBoot || !finite(lease?.expiresBoottimeNs) || !finite(lease?.nowNs) || lease.expiresBoottimeNs <= lease.nowNs || !windowOf(events, start - 2000, end) || end < start + 5000) return invalid("no live unexpired forged-boot lease or traffic window");
  if ((lease.expiresBoottimeNs - lease.nowNs) / 1e6 < end - start + 1500) return invalid("lease may have expired during bootId test");
  const warm = events.some((e) => e.pod === pod && e.k === "new" && e.s === 200 && e.t < start);
  const tested = events.filter((e) => e.pod === pod && e.k === "new" && e.t >= start + 1000 && e.t <= end);
  if (!warm || !tested.length || !tested.some((e) => e.s === 503)) return invalid("warm traffic/guard rejection missing");
  return tested.some((e) => e.s === 200) ? fail("guard accepted an old/forged boot lease") : pass();
}

export function clockRollback({ before, after, leaseExpires, samples, events, start, end, pod, exercised }) {
  if (!exercised || !before?.boot || before.boot !== after?.boot || ![before.wall, after.wall, before.mono, after.mono, leaseExpires].every(finite) || after.wall >= before.wall - 30_000 || after.mono < before.mono) return invalid("no deliberate backwards civil-clock step on the same boot");
  if (leaseExpires <= after.mono + 1000) return invalid("no unexpired lease at the deliberate clock step");
  if (!Array.isArray(samples) || !samples.length || !windowOf(events, start - 2000, end)) return invalid("clock/traffic observation incomplete");
  if (samples.some((s) => ![s.mono, s.t, s.observerBefore, s.observerAfter].every(finite) || s.observerAfter < s.observerBefore || s.boot !== before.boot)) return invalid("incompatible monotonic samples");
  // The remote BOOTTIME read occurred between observerBefore/After. Intersect all brackets; using just the later
  // timestamp could hide an extension for an entire SSH round trip. Date.now resolution widens each side by 1 ms.
  const lower = Math.max(...samples.map((s) => s.observerBefore - s.mono - 1));
  const upper = Math.min(...samples.map((s) => s.observerAfter - s.mono + 1));
  if (lower > upper || upper - lower > 1000) return invalid("node/observer clocks cannot locate lease expiry precisely");
  const earliest = leaseExpires + lower + 1000, latest = leaseExpires + upper + 1000;
  if (!samples.some((s) => s.mono >= leaseExpires + 1000) || end < latest + 5000) return invalid("lease expiry not observed for long enough");
  const tested = events.filter((e) => e.pod === pod && e.k === "new" && e.t >= earliest && e.t <= end);
  if (!events.some((e) => e.pod === pod && e.s === 200 && e.t < start) || !tested.length) return invalid("no warm/post-expiry traffic");
  if (tested.some((e) => e.s === 200 && e.requestedAt > latest)) return fail("civil clock rollback extended a monotonic lease");
  if (tested.some((e) => e.s === 200)) return invalid("success within the clock correlation uncertainty");
  return tested.some((e) => e.s === 503 && e.t > latest) ? pass() : invalid("guard 503 not observed after expiry");
}

// Negative replay is separate from the live result: a deliberately unsafe copy MUST be rejected by the same oracle.
// It cannot make an unexercised live gate PASS and is recorded as replay, never as a physical fault injection.
export function negativeReplay(check, evidence, corrupt) {
  const copy = structuredClone(evidence);
  corrupt(copy);
  const observed = check(copy);
  return { kind: "negative-evidence-replay", expected: "FAIL", observed, result: observed.result === "FAIL" ? "PASS" : "FAIL" };
}
