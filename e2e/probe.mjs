#!/usr/bin/env node
// N2-D2 against the real Kong 3.9.4 image: the real isolation-probe, in the gateway's network namespace, is the only
// source of the lease. Without an admission signed by the instance key, nothing starts; with one, a conclusive round
// starts Kong and the guard canary makes the pod Ready. A forbidden target that becomes reachable is a violation:
// measured from that moment, detection, 503 and Kong stopped, and the violation outlives the target and a restart of
// the probe. A configuration without the canary's guard is guard-missing and stops Kong. PROBE=blind is the negative
// control: a probe configured without that target never notices, and the same checks must fail.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { NODE_IMAGE } from "./docker-images.mjs";
import { docker, ECHO_IMAGE, Harness, root } from "./isolation-harness.mjs";

const { composeWorkspaces } = await import(pathToFileURL(join(root, "packages/compiler/dist/index.js")).href);
const blind = process.env.PROBE === "blind";
const failures = [];
const expectContained = (ok, message) => { if (!ok) failures.push(message); };
const check = (ok, message) => assert.ok(ok, message);
const CLUSTER = "6a1f3c2e-0b7d-4c1a-9f10-0000000000c1";

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

// Every capability has a forbidden target on a real host whose port is closed (refused, not unresolved: a name that
// does not resolve proves nothing). "forbidden-cap2" resolves from the start and begins listening on cue. The echo
// backend is the positive control (DNS and an allowed connection). The blind probe has no target for that address.
function probeConfig() {
  const checks = ["CAP-1", "CAP-3", "CAP-4", "CAP-5", "CAP-6", "CAP-7"].map((capability, i) => ({ capability, kind: "tcp", name: capability, address: `echo:${81 + i}` }));
  checks.push({ capability: "CAP-2", kind: "tcp", name: "resident node", address: blind ? "echo:87" : "forbidden-cap2:80" });
  checks.push({ capability: "CAP-4", kind: "dns", name: "cluster dns", host: "echo" });
  checks.push({ capability: "CAP-1", kind: "tcp-open", name: "allowed backend", address: "echo:80" });
  return { checks };
}

// A server that resolves at once and listens on :80 only after /tmp/open exists.
const TARGET = "const fs=require('fs'),net=require('net');let s=null;setInterval(()=>{if(!s&&fs.existsSync('/tmp/open')){s=net.createServer(c=>c.end()).listen(80)}},100)";

const b64 = (data) => Buffer.from(data).toString("base64url");
function jws(privateKey, claims) {
  const protectedHeader = b64(JSON.stringify({ alg: "EdDSA" }));
  const payload = b64(JSON.stringify(claims));
  return JSON.stringify({ protected: protectedHeader, payload, signature: b64(sign(null, Buffer.from(`${protectedHeader}.${payload}`), privateKey)) });
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

const nginx = async (id) => Number((await docker("exec", id, "sh", "-c", "cat /proc/[0-9]*/comm 2>/dev/null | grep -c '^nginx$' || true")).stdout.trim());
const probeState = async (harness) => JSON.parse((await docker("run", "--rm", "-v", `${harness.leaseVolume}:/v:ro`, NODE_IMAGE, "cat", "/v/probe-state.json")).stdout);
const ready = (probe) => docker("exec", probe, "/gromesh/bin/isolation-probe", "ready").then(() => true, () => false);

async function main() {
  const harness = new Harness();
  try {
    await harness.setup();
    const handoff = join(harness.dir, "handoff");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const instancePublicKey = publicKey.export({ format: "jwk" }).x;
    const target = (await docker("run", "-d", "--rm", "--network", harness.network, "--network-alias", "forbidden-cap2", NODE_IMAGE, "node", "-e", TARGET)).stdout.trim();
    harness.containers.push(target);
    const { id: kong, proxy } = await harness.gateway(composeWorkspaces([member]), { supervised: true });
    let probe = await harness.probe(kong, { config: probeConfig(), instancePublicKey, clusterId: CLUSTER, handoff });

    // No admission: no lease, no nginx.
    await sleep(5000);
    check((await nginx(kong)) === 0 && !(await ready(probe)), "nothing may start without an admission");
    // An admission for another pod is ignored.
    const probePublicKey = readFileSync(join(handoff, "probe.pub"), "utf8").trim();
    const bootId = (await docker("exec", kong, "cat", "/proc/sys/kernel/random/boot_id")).stdout.trim();
    const claims = { clusterId: CLUSTER, podUid: harness.podUid, nodeName: "kind-worker", bootId, admissionId: "6a1f3c2e-0b7d-4c1a-9f10-0000000000ad", probePublicKey, startDeadline: new Date(Date.now() + 300_000).toISOString() };
    await docker("run", "--rm", "-v", `${handoff}:/h`, NODE_IMAGE, "sh", "-c", `printf '%s' '${jws(privateKey, { ...claims, podUid: "6a1f3c2e-0b7d-4c1a-9f10-0000000000ff" })}' > /h/admission.jws`);
    await sleep(17_000);
    check((await nginx(kong)) === 0, "an admission of another pod must be ignored");

    // Admitted: the next round issues the lease, Kong starts, the canary makes the probe Ready.
    await docker("run", "--rm", "-v", `${handoff}:/h`, NODE_IMAGE, "sh", "-c", `printf '%s' '${jws(privateKey, claims)}' > /h/admission.jws`);
    check((await until(() => status(proxy), (s) => s === 200, 40_000)) !== null, "the admitted pod must serve");
    check((await until(() => ready(probe), Boolean, 10_000)) !== null, "the guard canary must make the probe Ready");

    // A forbidden target becomes reachable; t = 0 is the first time the gateway's own namespace reaches it.
    await docker("exec", target, "touch", "/tmp/open");
    const reachable = await until(async () => (await docker("exec", kong, "bash", "-c", "(exec 3<>/dev/tcp/forbidden-cap2/80) 2>/dev/null && echo up || echo down")).stdout.trim(), (v) => v === "up", 10_000);
    check(reachable !== null, "the forbidden target must become reachable from the gateway's network namespace");
    const detected = await until(async () => JSON.parse((await docker("exec", probe, "cat", "/gromesh/isolation/probe-state.json")).stdout).state, (s) => s === "violation", 30_000);
    let first;
    const refused = await until(async () => (first = await status(proxy)), (s) => s !== 200, 30_000);
    const stopped = await until(() => nginx(kong), (n) => n === 0, 30_000);
    const notReady = await until(() => ready(probe), (r) => r === false, 30_000);
    const after = (t) => (t === null ? Infinity : Math.round(t - reachable));
    // The budgets of B §3.5.3 from the loss, plus only the measurement's own latency (polling and docker exec).
    const SLACK = 300;
    expectContained(after(detected) <= 18_000 + SLACK, `violation detected ${after(detected)} ms after a forbidden target became reachable (budget 18 s)`);
    expectContained(refused !== null && (first === 503 || first === "down") && after(refused) <= 19_000 + SLACK, `requests still served ${after(refused)} ms after a forbidden target became reachable, then ${first} (budget 19 s)`);
    expectContained(after(stopped) <= 20_000 + SLACK, `Kong still running ${after(stopped)} ms after a forbidden target became reachable (budget 20 s)`);
    expectContained(after(notReady) <= 20_000 + SLACK, `the pod still Ready ${after(notReady)} ms after a forbidden target became reachable (budget 20 s)`);
    console.log(`violation: detected after ${after(detected)} ms, refused (${first}) after ${after(refused)} ms, Kong stopped after ${after(stopped)} ms, NotReady after ${after(notReady)} ms`);

    // The violation stays after the target leaves and after the probe restarts (its state is on its volume).
    await docker("exec", target, "sh", "-c", "rm /tmp/open; kill 1");
    await docker("restart", probe);
    await sleep(20_000);
    const state = await probeState(harness).catch(() => ({}));
    expectContained(state.state === "violation" && (await nginx(kong)) === 0, `a violation must outlive its target and a probe restart (state ${state.state})`);

    if (!blind) {
      // A configuration whose canary has no guard: guard-missing, lease withdrawn, Kong stopped.
      const unguarded = composeWorkspaces([member]);
      const canary = unguarded.routes.find((r) => r.paths?.includes("/.gromesh/guard/current"));
      unguarded.plugins = unguarded.plugins.filter((p) => p.route !== canary.id);
      const second = new Harness();
      try {
        await second.setup();
        second.containers.push((await docker("run", "-d", "--rm", "--network", second.network, "--network-alias", "forbidden-cap2", NODE_IMAGE, "node", "-e", TARGET)).stdout.trim());
        const handoff2 = join(second.dir, "handoff");
        const { id: kong2, proxy: proxy2 } = await second.gateway(unguarded, { supervised: true });
        const probe2 = await second.probe(kong2, { config: probeConfig(), instancePublicKey, clusterId: CLUSTER, handoff: handoff2 });
        await second.waitFor("probe key", async () => readFileSync(join(handoff2, "probe.pub"), "utf8").length > 0);
        const key2 = readFileSync(join(handoff2, "probe.pub"), "utf8").trim();
        await docker("run", "--rm", "-v", `${handoff2}:/h`, NODE_IMAGE, "sh", "-c", `printf '%s' '${jws(privateKey, { ...claims, podUid: second.podUid, probePublicKey: key2 })}' > /h/admission.jws`);
        // The canary runs every second from the start: the unguarded configuration is caught before it serves.
        // t = 0 when Kong first answers with this configuration (a path without a route: Kong's own 404).
        const started = await until(async () => (await fetch(`${proxy2}/nothing-here`, { signal: AbortSignal.timeout(500) })).status === 404, Boolean, 40_000);
        const missing = await until(async () => JSON.parse((await docker("exec", probe2, "cat", "/gromesh/isolation/probe-state.json")).stdout).state, (s) => s === "guard-missing", 30_000);
        const down = await until(() => nginx(kong2), (n) => n === 0, 10_000);
        check(started !== null, "the admitted pod starts Kong and Kong answers (the canary is checked after the start)");
        check(missing !== null && missing - started <= 2000 + 300, `the missing guard must be found within 1 s of the start (${missing === null ? "never" : missing - started} ms)`);
        check(down !== null && down - missing <= 2000 + 300, `guard-missing must stop Kong within 2 s (${down === null ? "never" : down - missing} ms)`);
        check(!(await ready(probe2)), "a guard-missing pod is never Ready");
        console.log(`guard-missing: found ${missing - started} ms after the start, Kong stopped ${down - missing} ms later`);
      } finally {
        await second.teardown();
      }
    }

    if (failures.length > 0) throw new Error(`Probe containment failed:\n- ${failures.join("\n- ")}`);
    console.log("The isolation-probe holds on the real gateway: admission, start, canary, violation, persistence, guard-missing");
  } finally {
    await harness.teardown();
  }
}

await main();
