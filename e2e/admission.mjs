#!/usr/bin/env node
// N2-D3 against the real Kong 3.9.4 image: the real isolation-probe accepts only an admission signed by a key of its
// InstanceTrustSet with the typed header of agent-protocol-v2, stops serving at the next round once that key leaves
// the set (a rollout without it), and signs one report per round, numbered without gaps and chained by prevDigest,
// that the agent finds in handoff/outbox in order and that survive a crash of the probe's container. On SIGTERM, with
// Kong already stopped, the last report is pod-terminated with kongStopConfirmed. ADMISSION=control is the negative
// control: the refused admissions are replaced by a good one, the key stays in the set and the chain is checked with
// a wrong digest, and the same checks must fail.
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { NODE_IMAGE } from "./docker-images.mjs";
import { docker, Harness, instanceJws, instanceKey, root } from "./isolation-harness.mjs";
import { assertStack } from "../scripts/stack-guard.mjs";

await assertStack("acceptance");

const { composeWorkspaces } = await import(pathToFileURL(join(root, "packages/compiler/dist/index.js")).href);
const control = process.env.ADMISSION === "control";
const failures = [];
const expectProven = (ok, message) => { if (!ok) failures.push(message); };
const check = (ok, message) => assert.ok(ok, message);
const CLUSTER = "6a1f3c2e-0b7d-4c1a-9f10-0000000000c1";
const ADMISSION = "6a1f3c2e-0b7d-4c1a-9f10-0000000000ad";
const ROUND = 15_000;

const member = {
  id: "00000000-0000-4000-8000-00000000a001",
  slug: "tvro",
  state: {
    services: [{ id: "6a1f3c2e-0b7d-4c1a-9f10-a00000000001", name: "echo", protocol: "http", host: "echo", port: 80 }],
    routes: [{ id: "6a1f3c2e-0b7d-4c1a-9f10-a00000000002", name: "recarga", serviceId: "6a1f3c2e-0b7d-4c1a-9f10-a00000000001", paths: ["/recarga"] }],
    consumers: [],
    keyAuthCredentials: [],
    plugins: [],
  },
};

// Every capability has a forbidden target whose port is closed on a real host; the echo backend is the positive
// control (DNS and an allowed connection).
function probeConfig() {
  const checks = Array.from({ length: 7 }, (_, i) => ({ capability: `CAP-${i + 1}`, kind: "tcp", name: `CAP-${i + 1}`, address: `echo:${81 + i}` }));
  checks.push({ capability: "CAP-4", kind: "dns", name: "cluster dns", host: "echo" });
  checks.push({ capability: "CAP-1", kind: "tcp-open", name: "allowed backend", address: "echo:80" });
  return { checks };
}

async function status(proxy) {
  try {
    const res = await fetch(`${proxy}/tvro/recarga`, { signal: AbortSignal.timeout(1500) });
    await res.arrayBuffer();
    return res.status;
  } catch (error) {
    return error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "down";
  }
}

async function until(fn, ok, timeoutMs) {
  const began = Date.now();
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (ok(value)) return Date.now();
    if (Date.now() - began > timeoutMs) return null;
    await sleep(100);
  }
}

// Only the serving nginx (its master/worker titles): the image's HEALTHCHECK runs `kong health`, whose resty CLI is an nginx binary too.
const nginx = async (id) => Number((await docker("exec", id, "sh", "-c", "for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done | grep -cE '^nginx: (master|worker) process' || true")).stdout.trim());
const probeLogs = async (id) => docker("logs", id).then((r) => r.stdout + r.stderr, () => "");

/** The outbox as the agent reads it: each report verified like the control plane does (typed header, probe key). */
function outbox(handoff, probePublicKey) {
  const dir = join(handoff, "outbox");
  if (!existsSync(dir)) return [];
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: probePublicKey }, format: "jwk" });
  return readdirSync(dir).filter((n) => /^[0-9]{20}\.jws$/.test(n)).sort().map((name) => {
    const jws = JSON.parse(readFileSync(join(dir, name), "utf8"));
    assert.deepEqual(Object.keys(jws).sort(), ["payload", "protected", "signature"]);
    assert.equal(Buffer.from(jws.protected, "base64url").toString(), '{"alg":"EdDSA","typ":"gromesh-probe-report+json"}', `${name}: header`);
    assert.ok(verify(null, Buffer.from(`${jws.protected}.${jws.payload}`), key, Buffer.from(jws.signature, "base64url")), `${name}: signature`);
    const payload = Buffer.from(jws.payload, "base64url");
    const report = JSON.parse(payload);
    assert.equal(name, `${String(report.seq).padStart(20, "0")}.jws`);
    return { name, report, payload, raw: Buffer.from(JSON.stringify(jws)) };
  });
}

/** Seq without gaps and prevDigest = sha256 of the previous payload bytes (the control mode hashes the whole JWS). */
function chainProblem(reports, previous) {
  for (const { report, payload, raw } of reports) {
    if (previous && report.seq !== previous.report.seq + 1) return `seq ${report.seq} after ${previous.report.seq}`;
    const expected = previous ? `sha256:${createHash("sha256").update(control ? previous.raw : previous.payload).digest("hex")}` : null;
    if (report.seq === 1 ? report.prevDigest !== null : report.prevDigest !== expected) return `seq ${report.seq}: prevDigest ${report.prevDigest}, want ${expected}`;
    previous = { report, payload, raw };
  }
  return null;
}

async function main() {
  const harness = new Harness();
  try {
    await harness.setup();
    const handoff = join(harness.dir, "handoff");
    const trusted = instanceKey();
    const outsider = instanceKey();
    const { id: kong, proxy, state: kongState } = await harness.gateway(composeWorkspaces([member]), { supervised: true });
    const probe = await harness.probe(kong, { config: probeConfig(), trustSet: [trusted], clusterId: CLUSTER, handoff, kongState });
    await harness.waitFor("probe key", async () => readFileSync(join(handoff, "probe.pub"), "utf8").length === 43, { id: probe });
    const probePublicKey = readFileSync(join(handoff, "probe.pub"), "utf8");
    const bootId = (await docker("exec", kong, "cat", "/proc/sys/kernel/random/boot_id")).stdout.trim();
    const claims = { clusterId: CLUSTER, podUid: harness.podUid, nodeName: "worker-1", bootId, admissionId: ADMISSION, probePublicKey, startDeadline: new Date(Date.now() + 300_000).toISOString() };
    const good = instanceJws(trusted, "gromesh-admission+json", claims);

    // Signed outside the trust set, under a trusted kid by another key, and a release presented as an admission: each
    // held for a whole round, none starts anything.
    const refusals = [
      ["an admission of an unknown kid", instanceJws(outsider, "gromesh-admission+json", claims), "is not in the instance trust set"],
      ["an admission of a trusted kid signed by another key", instanceJws(outsider, "gromesh-admission+json", claims, { kid: trusted.kid }), "jws signature invalid"],
      ["a release presented as an admission", instanceJws(trusted, "gromesh-isolation-release+json", claims), 'jws typ "gromesh-isolation-release+json"'],
    ];
    for (const [what, jws, reason] of refusals) {
      await harness.put(handoff, "admission.jws", control ? good : jws);
      await sleep(ROUND + 2000);
      const served = (await nginx(kong)) > 0 || outbox(handoff, probePublicKey).length > 0;
      expectProven(!served, `${what} was accepted: Kong started or reports were signed`);
      if (!control) check((await probeLogs(probe)).includes(reason), `${what}: the probe did not refuse it for its reason (${reason})`);
    }

    // The trusted admission: served, Ready-bound, and one report per round.
    await harness.put(handoff, "admission.jws", good);
    check((await until(() => status(proxy), (s) => s === 200, 2 * ROUND + 5000)) !== null, "the admitted pod must serve");
    await harness.waitFor("three reports", async () => outbox(handoff, probePublicKey).length >= 3, { timeoutMs: 4 * ROUND, id: probe });
    let reports = outbox(handoff, probePublicKey);
    check(reports.every(({ report }) => report.admissionId === ADMISSION && report.bootId === bootId && report.podUid === harness.podUid && report.clusterId === CLUSTER && !report.final), "reports name this admission, pod, boot and cluster");
    const first = chainProblem(reports, null);
    expectProven(first === null, `the outbox chain is broken: ${first}`);

    // The control plane acks seq 1: it leaves the outbox (and the queue) at the next round, the others stay.
    const acked = reports[0];
    await harness.put(handoff, "acks.json", JSON.stringify({ admissionId: ADMISSION, ackedSeq: 1 }));
    await harness.waitFor("seq 1 dropped after its ack", async () => outbox(handoff, probePublicKey)[0]?.report.seq === 2, { timeoutMs: ROUND + 5000, id: probe });

    // A crash of the probe's container: the queue, the seq and the key survive; the chain continues without a gap.
    const beforeCrash = outbox(handoff, probePublicKey).at(-1).report.seq;
    await docker("kill", "--signal", "KILL", probe);
    await docker("start", probe);
    await harness.waitFor("two reports after the restart", async () => outbox(handoff, probePublicKey).at(-1).report.seq >= beforeCrash + 2, { timeoutMs: 3 * ROUND + 5000, id: probe });
    reports = outbox(handoff, probePublicKey);
    check(readFileSync(join(handoff, "probe.pub"), "utf8") === probePublicKey, "the probe key survives a restart");
    const restarted = chainProblem(reports, acked);
    expectProven(restarted === null, `the chain across the restart is broken: ${restarted}`);
    check(reports.every(({ report }) => !report.final), "a crash sends no final report");
    console.log(`reports: seq ${reports[0].report.seq}..${reports.at(-1).report.seq} chained across a crash of the probe (last before it ${beforeCrash})`);
    check((await status(proxy)) === 200, "the pod serves on after the probe's restart");

    // A rollout of the chart without the key: the admission stops counting at the next round. The supervisor is frozen
    // first, so the guard alone must answer 503; Kong's stop is measured when the supervisor resumes.
    await docker("kill", "--signal", "STOP", kong);
    const rolled = Date.now();
    harness.trustSet(control ? [trusted] : [outsider]);
    const refused = await until(() => status(proxy), (s) => s === 503, 2 * ROUND);
    const after = (t) => (t === null ? Infinity : t - rolled);
    // The next round within P (+ its start), then the guard's 1 s cache.
    expectProven(after(refused) <= ROUND + 1000 + 1000 + 500, `no 503 ${after(refused)} ms after the key left the trust set (budget P + 1 s cache + 1 s)`);
    const resumed = Date.now();
    await docker("kill", "--signal", "CONT", kong);
    const stopped = await until(() => nginx(kong), (n) => n === 0, 10_000);
    if (stopped === null || stopped - resumed > 2000 + 300) {
      const logs = await docker("logs", "-t", "--since", new Date(resumed - 2000).toISOString(), kong).then((r) => r.stdout + r.stderr, () => "");
      console.error(`resumed at ${new Date(resumed).toISOString()}, supervisor log:\n${logs.split("\n").filter((l) => /lease|nginx|supervisor/.test(l)).slice(-15).join("\n")}`);
    }
    expectProven(stopped !== null && stopped - resumed <= 2000 + 300, `the resumed supervisor left Kong running ${stopped === null ? "∞" : stopped - resumed} ms (budget S + F = 2 s)`);
    console.log(`key removed from the trust set: 503 after ${after(refused)} ms; Kong stopped ${stopped === null ? "∞" : stopped - resumed} ms after the supervisor resumed`);

    // The pod stops: Kong first (native sidecar order), then the probe's SIGTERM, whose final report confirms it.
    await docker("stop", "--time", "20", kong);
    await docker("stop", "--time", "10", probe);
    const final = outbox(handoff, probePublicKey).at(-1).report;
    check(final.final && final.finalReason === "pod-terminated", `the last report must be the final pod-terminated one (${JSON.stringify(final)})`);
    expectProven(final.kongStopConfirmed === true, `kongStopConfirmed ${final.kongStopConfirmed} after Kong stopped`);
    const whole = chainProblem(outbox(handoff, probePublicKey), acked);
    expectProven(whole === null, `the chain up to the final report is broken: ${whole}`);
    const state = JSON.parse((await docker("run", "--rm", "-v", `${harness.leaseVolume}:/v:ro`, NODE_IMAGE, "cat", "/v/probe-state.json")).stdout);
    check(state.closedAdmissions?.includes(ADMISSION), "the final report ends the admission in the probe");

    if (failures.length > 0) throw new Error(`Admission proof failed:\n- ${failures.join("\n- ")}`);
    console.log("The isolation-probe holds on the real gateway: trust set, typed admissions, key removal, chained reports, crash, final report");
  } finally {
    await harness.teardown();
  }
}

await main();
