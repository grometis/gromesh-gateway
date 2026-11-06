import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { bootLeaseRejected, negativeReplay, probeFailure, probeRestart, windowOf } from "./scenario-checks.mjs";

// Dependency injection shares v2's guarded lab, images, observer and cleanup. Importing this file has no effects.
export async function probeOnlyRestart(o) {
  const p = (await o.live())[0];
  const client = await o.client(p, "f4");
  await sleep(4000);
  const before = await o.snapshot(p);
  const samples = [];
  const start = await o.now();
  let collecting = true, samplingError;
  const sampler = (async () => {
    try { while (collecting) { samples.push(await o.snapshot(p)); await sleep(150); } }
    catch (error) { samplingError = error.message; }
  })();
  let after, end;
  try {
    // Stops only this CRI container, allowing kubelet to restart its native sidecar. No Pod delete/SIGCONT.
    await o.stopProbe(p);
    await sleep(65_000);
    after = await o.snapshot(p);
    end = await o.now();
    await sleep(1000);
  } finally { collecting = false; await sampler; await client.stop(); }
  const reports = await o.chain(before.admission);
  const evidence = { before, after, samples, start, end, events: client.events, pod: p.name, reports };
  const verdict = samplingError ? { result: "INVALID", reason: `lease sampling failed: ${samplingError}` } : probeRestart(evidence);
  const negative = negativeReplay(probeRestart, evidence, (e) => { const s = e.samples.find((x) => x.lease && x.t > e.start); if (s) s.final = true; });
  return { evidence, verdict, negative };
}

export async function probeStopped(o, independent) {
  const [p, healthy] = await o.live();
  if (!healthy) return { verdict: { result: "INVALID", reason: "two serving replicas required" } };
  const client = await o.client(p, independent ? "probe-independent" : "probe-supervisor");
  const other = await o.client(healthy, "probe-survivor");
  await sleep(4000);
  let frozenProbe, frozenSupervisor, independentFrozenAt, frozenNginx, start, end, exit;
  const observed = independent ? await o.beginExit(p) : null;
  try {
    // Earliest possible freeze: bounds the elapsed time conservatively, includes execution latency.
    start = await o.now();
    frozenProbe = await o.freeze(p.name, "isolation-probe", "isolation-probe");
    if (independent) {
      // Align to the actual last lease, not to an assumed renewal at the freeze. Kong must still be running.
      const wait = Math.max(0, (await o.remaining(p)) - 3000);
      await sleep(wait);
      frozenNginx = await o.nginxRunning(p);
      independentFrozenAt = await o.now();
      frozenSupervisor = await o.freeze(p.name, "kong", "kong-supervisor");
      await sleep(Math.max(0, 46_000 - wait));
    } else await sleep(46_000);
    end = await o.now();
    exit = await o.exit(p, start, observed);
    await sleep(1000);
  } finally {
    await client.stop(); await other.stop();
    if (frozenProbe) await o.thaw(frozenProbe);
    if (frozenSupervisor) await o.thaw(frozenSupervisor);
  }
  // Streams have independent seq counters; normalize only after validating each original stream separately.
  const evidence = { events: client.events, survivorEvents: other.events, start, end, victim: p.name, survivor: healthy.name,
    stopped: exit, independent, independentFrozenAt, frozenNginx, exercised: Boolean(frozenProbe) };
  const verdict = probeFailureStreams(evidence);
  const negative = negativeReplay(probeFailureStreams, evidence, (e) => {
    const late = e.events.find((x) => x.k === "new" && x.t > e.start + 34_000); if (late) late.s = 200;
  });
  return { evidence, verdict, negative };
}

export function probeFailureStreams(e) {
  if (!windowOf(e.survivorEvents, e.start - 2000, e.end)) return { result: "INVALID", reason: "survivor observation incomplete" };
  // Merge preserves actual timestamps and identity; sequence is only used by the individual stream validators.
  if (!windowOf(e.events, e.start - 2000, e.end)) return { result: "INVALID", reason: "victim observation incomplete" };
  if (e.events[0].boot !== e.survivorEvents[0].boot) return { result: "INVALID", reason: "streams use different reference kernels" };
  const events = [...e.events, ...e.survivorEvents].sort((a, b) => a.t - b.t).map((x, i) => ({ ...x, seq: i + 1, observer: "validated-streams", boot: "same-kind-kernel" }));
  return probeFailure({ ...e, events });
}

export async function forgedBootLease(o) {
  const p = (await o.live())[0];
  const client = await o.client(p, "boot-lease");
  await sleep(4000);
  let target, start, end, written;
  const forgedBoot = randomUUID();
  try {
    target = await o.freeze(p.name, "isolation-probe", "isolation-probe");
    written = await o.forgeLease(p, forgedBoot);
    // Lease cache is 1 s; begin after write has completed, keep the full following 6 s window.
    start = await o.now();
    await sleep(6500);
    end = await o.now();
    await sleep(1000);
  } finally { await client.stop(); if (target) await o.thaw(target); }
  const evidence = { events: client.events, start, end, pod: p.name, actualBoot: written?.actualBoot, forgedBoot, lease: written?.lease, exercised: Boolean(written) };
  const verdict = bootLeaseRejected(evidence);
  const negative = negativeReplay(bootLeaseRejected, evidence, (e) => { const r = e.events.find((x) => x.k === "new" && x.t > e.start + 1000); if (r) r.s = 200; });
  return { evidence, verdict, negative };
}
