#!/usr/bin/env node
// Environment B: operates only on an already provisioned, explicitly pinned disposable VM cluster. No kind/Docker,
// no provisioning, no global kubeconfig. The observer and CP must be on kernels independent of the victim.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { assertLabKubeconfig } from "../checks.mjs";
import { CLIENT } from "../components/client-script.mjs";
import { clockRollback, negativeReplay, nodeReboot, windowOf } from "./scenario-checks.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const name = /^[a-z0-9][a-z0-9.-]*$/;
export function validateManifest(m) {
  assert.equal(m.disposable, "gromesh-n2-environment-b");
  for (const k of ["context", "namespace", "cpNamespace", "postgresPod", "victimPod", "survivorPod"]) assert.match(m[k] ?? "", name, k);
  assert.match(m.clusterId ?? "", uuid);
  assert.match(m.systemNamespaceUid ?? "", uuid);
  assert.match(m.caSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.match(m.server ?? "", /^https:\/\//);
  assert.ok(Array.isArray(m.nodes) && m.nodes.length >= 3, "victim, survivor and CP/observer nodes required");
  for (const n of m.nodes) {
    assert.match(n.name ?? "", name);
    assert.match(n.ssh ?? "", /^[a-z_][a-z0-9_-]*@[a-zA-Z0-9.-]+$/);
    assert.match(n.machine ?? "", /^[a-f0-9]{32}$/);
  }
  assert.equal(new Set(m.nodes.map((n) => n.machine)).size, m.nodes.length, "independent machine IDs required");
  assert.equal(new Set(m.nodes.map((n) => n.name)).size, m.nodes.length);
  for (const k of ["namespace", "pod"]) assert.match(m.observer?.[k] ?? "", name);
  assert.ok(m.knownHosts && m.trafficKeyFile && m.path && m.wsPath);
  assert.ok(isAbsolute(m.knownHosts) && isAbsolute(m.trafficKeyFile), "absolute input paths required");
  assert.ok(m.path.startsWith("/") && m.wsPath.startsWith("/"));
  assert.ok(Array.isArray(m.expectedImageIds) && m.expectedImageIds.length > 0);
  for (const id of m.expectedImageIds) assert.match(id, /sha256:[a-f0-9]{64}$/);
  assert.ok(Number.isInteger(m.revision) && m.revision > 0);
  return m;
}

// Commands are argument vectors locally and single-quoted remotely. Neither manifest paths nor JSON are shell code.
const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
async function command(bin, args, input, timeout = 30_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { env: { ...process.env, KUBECONFIG: process.env.LAB_KUBECONFIG }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", (s) => { stdout += s; }); child.stderr.on("data", (s) => { stderr += s; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolvePromise(stdout) : reject(new Error(`${bin} exited ${code}: ${stderr.slice(0, 800)}`)); });
    child.stdin.on("error", () => {}); child.stdin.end(input ?? "");
  });
}

export async function main() {
  const out = process.env.LAB_OUT;
  assert.ok(out, "LAB_OUT required");
  mkdirSync(out, { recursive: true }); chmodSync(out, 0o700);
  const report = { startedAt: new Date().toISOString(), environment: "B", items: [], timeline: [], cleanup: [] };
  const save = () => writeFileSync(join(out, "results.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  const runId = randomBytes(8).toString("hex");
  const clients = [];
  let restoreUnit, clockRestore, frozen, victimNode, m, victim;
  let interrupted = false;
  const onSignal = () => { interrupted = true; };
  process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
  const ensureRunning = () => assert.ok(!interrupted, "run interrupted");
  const pause = async (ms) => { for (let left = ms; left > 0; left -= 500) { ensureRunning(); await sleep(Math.min(500, left)); } };
  const record = (id, evidence, check, corrupt) => {
    const verdict = check(evidence);
    const control = negativeReplay(check, evidence, corrupt);
    report.items.push({ id, result: verdict.result === "PASS" && control.result === "PASS" ? "pass" : verdict.result === "INVALID" ? "incomplete" : "fail", measures: { evidence, verdict }, negative: [control] }); save();
  };
  const ssh = async (node, action, payload = {}) => {
    const args = ["sudo", "-n", "python3", "-", action, Buffer.from(JSON.stringify({ ...payload, machine: node.machine, run: runId })).toString("base64")];
    const stdout = await command("ssh", ["-F", "/dev/null", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "GlobalKnownHostsFile=/dev/null", "-o", `UserKnownHostsFile=${resolve(m.knownHosts)}`, "-o", "ConnectTimeout=5", node.ssh, args.map(quote).join(" ")], readFileSync(join(here, "host-ops.py")), 15_000);
    const result = JSON.parse(stdout);
    report.timeline.push({ action, node: node.name, executorAt: Date.now(), result }); save();
    return result;
  };
  let k, kj, now, state;
  try {
    assert.equal(process.version, "v24.18.0", "use the pinned Node version");
    assertLabKubeconfig(process.env.LAB_KUBECONFIG, homedir());
    m = validateManifest(JSON.parse(readFileSync(process.env.HOST_EVENTS_MANIFEST, "utf8")));
    assert.equal(statSync(m.trafficKeyFile).mode & 0o077, 0, "traffic key must be private");
    assert.ok(statSync(m.knownHosts).isFile());
    const key = readFileSync(m.trafficKeyFile, "utf8").trim();
    assert.ok(key, "empty traffic key");
    const versions = readFileSync(join(here, "../versions.env"), "utf8");
    const pin = (n) => new RegExp(`^${n}=(.+)$`, "m").exec(versions)[1];
    k = (args, input, timeout) => command("kubectl", ["--kubeconfig", process.env.LAB_KUBECONFIG, "--context", m.context, "--request-timeout=15s", ...args], input, timeout);
    kj = async (args) => JSON.parse(await k([...args, "-o", "json"]));
    const config = JSON.parse(await k(["config", "view", "--minify", "--raw", "-o", "json"]));
    const cluster = config.clusters[0].cluster;
    assert.equal(cluster.server, m.server);
    assert.ok(!cluster["insecure-skip-tls-verify"] && cluster["certificate-authority-data"], "embedded pinned CA required");
    assert.equal(createHash("sha256").update(Buffer.from(cluster["certificate-authority-data"], "base64")).digest("hex"), m.caSha256);
    assert.equal((await kj(["get", "namespace", "kube-system"])).metadata.uid, m.systemNamespaceUid);
    for (const ns of new Set([m.namespace, m.cpNamespace, m.observer.namespace])) assert.equal((await kj(["get", "namespace", ns])).metadata.labels?.["gromesh.io/n2-lab"], "disposable");
    const nodes = (await kj(["get", "nodes"])).items;
    assert.equal(nodes.length, m.nodes.length, "manifest must enumerate every node");
    for (const node of m.nodes) {
      const actual = nodes.find((n) => n.metadata.name === node.name);
      assert.equal(actual?.status.nodeInfo.kubeletVersion, pin("KUBERNETES_VERSION"));
      const host = await ssh(node, "clock");
      assert.equal(actual.status.nodeInfo.bootID, host.boot);
      node.boot = host.boot;
    }
    assert.equal(new Set(m.nodes.map((n) => n.boot)).size, m.nodes.length, "shared kernel is not environment B");
    const cilium = await kj(["-n", "kube-system", "get", "pods", "-l", "k8s-app=cilium"]);
    assert.equal(cilium.items.length, nodes.length);
    for (const p of cilium.items) assert.ok(p.spec.containers.some((c) => c.image.endsWith("@" + pin("CILIUM_IMAGE_DIGEST"))));
    victim = await kj(["-n", m.namespace, "get", "pod", m.victimPod]);
    const survivor = await kj(["-n", m.namespace, "get", "pod", m.survivorPod]);
    const observer = await kj(["-n", m.observer.namespace, "get", "pod", m.observer.pod]);
    const postgres = await kj(["-n", m.cpNamespace, "get", "pod", m.postgresPod]);
    victimNode = m.nodes.find((n) => n.name === victim.spec.nodeName);
    assert.ok(victimNode);
    let executorMachine = null;
    try { executorMachine = readFileSync("/etc/machine-id", "utf8").trim(); } catch { /* executor may be macOS */ }
    assert.notEqual(executorMachine, victimNode.machine, "executor must not run on the node whose clock/kernel it changes");
    for (const p of [survivor, observer, postgres]) assert.notEqual(p.spec.nodeName, victim.spec.nodeName, "survivor/observer/CP database must survive victim reboot");
    const inventory = (await kj(["get", "pods", "-A"])).items.filter((p) => [m.namespace, m.cpNamespace, m.observer.namespace].includes(p.metadata.namespace));
    for (const p of inventory.filter((p) => p.metadata.namespace === m.cpNamespace)) assert.notEqual(p.spec.nodeName, victim.spec.nodeName, "every control plane component must use an independent node");
    for (const p of inventory) for (const c of [...(p.status.initContainerStatuses ?? []), ...(p.status.containerStatuses ?? [])]) {
      assert.ok(m.expectedImageIds.includes(c.imageID), `unreviewed imageID ${c.imageID}`);
      assert.match(c.imageID, /sha256:[a-f0-9]{64}$/);
    }
    report.manifestHash = createHash("sha256").update(readFileSync(process.env.HOST_EVENTS_MANIFEST)).digest("hex");
    report.inventory = inventory.map((p) => ({ name: p.metadata.name, uid: p.metadata.uid, node: p.spec.nodeName, images: [...(p.status.initContainerStatuses ?? []), ...(p.status.containerStatuses ?? [])].map((c) => ({ name: c.name, imageID: c.imageID })) })); save();
    now = async () => Number(await k(["-n", m.observer.namespace, "exec", m.observer.pod, "--", "node", "-p", "Date.now()"]));
    state = () => ssh(victimNode, "state", { uid: victim.metadata.uid });
    const podClient = async (p, label) => {
      const args = [p.status.podIP, "8000", m.path, key, m.wsPath, null, p.metadata.name, label];
      const child = spawn("kubectl", ["--kubeconfig", process.env.LAB_KUBECONFIG, "--context", m.context, "-n", m.observer.namespace, "exec", "-i", m.observer.pod, "--", "node", "--input-type=module", "-"], { stdio: ["pipe", "pipe", "pipe"] });
      const stream = { child, events: [], errors: [] };
      clients.push(stream);
      let buffer = "";
      child.on("error", (e) => stream.errors.push(e.message));
      child.stdout.on("data", (d) => { buffer += d; const lines = buffer.split("\n"); buffer = lines.pop(); for (const l of lines) { try { stream.events.push(JSON.parse(l)); } catch { stream.errors.push("invalid JSON line"); } } });
      child.stderr.on("data", () => { /* errors are reflected by missing/gapped events, never printed with credentials */ });
      child.stdin.on("error", () => {});
      child.stdin.end(`globalThis.ARGS=${JSON.stringify(JSON.stringify(args))};\n${CLIENT}`);
      return stream;
    };
    const sql = async (query) => JSON.parse((await k(["-n", m.cpNamespace, "exec", "-i", m.postgresPod, "--", "psql", "-U", "gromesh", "-d", "gromesh", "-v", "ON_ERROR_STOP=1", "-At", "-f", "-"], `select coalesce(json_agg(t), '[]'::json) from (${query}) t;\n`)).trim());
    const v = await podClient(victim, "B-victim"), h = await podClient(survivor, "B-survivor");
    await pause(5000);

    // First exercise the exact same measurement WITHOUT reboot. This physical same-boot control must be INVALID.
    const controlBefore = await state();
    await pause(1500);
    const controlAfter = await state();
    assert.equal(nodeReboot({ before: controlBefore, after: controlAfter, exercised: true }).result, "INVALID");
    report.sameBootControl = { before: controlBefore, after: controlAfter, result: "PASS", expected: "INVALID" }; save();

    const before = await state();
    assert.match(before.admission ?? "", uuid);
    const admissionRows = await sql(`select cluster_id, pod_uid, state from isolation_admissions where admission_id = '${before.admission}'`);
    assert.equal(admissionRows[0]?.cluster_id, m.clusterId);
    assert.equal(admissionRows[0]?.pod_uid, victim.metadata.uid);
    assert.equal(admissionRows[0]?.state, "open");
    const rebootStart = await now();
    const scheduled = await ssh(victimNode, "reboot");
    assert.equal(scheduled.boot, before.boot);
    let recovered, after, oldFinal;
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      ensureRunning();
      try {
        after = await state();
        if (after.boot !== before.boot) {
          recovered = after;
          const rows = await sql(`select payload from isolation_reports where admission_id = '${before.admission}' and final = true order by seq`);
          oldFinal = rows.map((r) => JSON.parse(Buffer.from(r.payload, "base64url"))).find((r) => r.finalReason === "node-reboot");
          if (oldFinal && recovered.ready && recovered.admission !== before.admission) break;
        }
      } catch { /* unavailable during the reboot: retained in timeline on successful observations */ }
      await pause(2000);
    }
    if (recovered) {
      assert.match(recovered.admission ?? "", uuid);
      const newRows = await sql(`select cluster_id, pod_uid, boot_id, state from isolation_admissions where admission_id = '${recovered.admission}'`);
      assert.equal(newRows[0]?.cluster_id, m.clusterId);
      assert.equal(newRows[0]?.pod_uid, victim.metadata.uid);
      assert.equal(newRows[0]?.boot_id, recovered.boot);
      assert.equal(newRows[0]?.state, "open");
      const observedPod = await kj(["-n", m.namespace, "get", "pod", m.victimPod]);
      recovered.ready = recovered.ready && observedPod.metadata.uid === victim.metadata.uid && observedPod.status.conditions?.some((c) => c.type === "Ready" && c.status === "True");
    }
    const rebootEnd = await now();
    await pause(6000);
    const healthyEvents = h.events.filter((e) => e.k === "new" && e.t >= rebootStart && e.t <= rebootEnd);
    const healthy = { node: survivor.spec.nodeName, boot: m.nodes.find((n) => n.name === survivor.spec.nodeName)?.boot,
      served: windowOf(h.events, rebootStart - 2000, rebootEnd) && healthyEvents.length > 0 && healthyEvents.every((e) => e.s === 200) };
    const rebootEvidence = { before: { ...before, node: victimNode.name }, after: after && { ...after, node: victimNode.name }, oldFinal,
      recovered: recovered && { ...recovered, served: v.events.some((e) => e.t >= rebootEnd && e.s === 200) }, survivor: healthy, exercised: true,
      start: rebootStart, end: rebootEnd, events: v.events.slice(), survivorEvents: h.events.slice() };
    record("node-reboot-real-bootId", rebootEvidence, nodeReboot, (e) => { if (e.oldFinal) e.oldFinal.kongStopConfirmed = false; });
    if (report.items.at(-1).result !== "pass") throw new Error("reboot gate did not pass; clock experiment refused on an unrecovered node");

    // Freeze only the probe; its already-issued monotonic lease must expire even though CLOCK_REALTIME goes back.
    victim = await kj(["-n", m.namespace, "get", "pod", m.victimPod]);
    const probe = victim.status.initContainerStatuses.find((c) => c.name === "isolation-probe");
    frozen = probe.containerID.replace(/^containerd:\/\//, "");
    await ssh(victimNode, "signal", { container: frozen, signal: "STOP" });
    const last = await state();
    assert.ok(last.expires > last.mono + 10_000, "lease too near expiry; repeat in a fresh run");
    const clockStart = await now();
    const unchangedBefore = await ssh(victimNode, "clock");
    await pause(1000);
    const unchangedAfter = await ssh(victimNode, "clock");
    const noStep = clockRollback({ before: unchangedBefore, after: unchangedAfter, exercised: true });
    assert.equal(noStep.result, "INVALID");
    report.clockNoStepControl = { before: unchangedBefore, after: unchangedAfter, expected: "INVALID", observed: noStep }; save();
    restoreUnit = `gromesh-n2-clock-${runId}`;
    const changed = await ssh(victimNode, "rollback");
    clockRestore = { before: changed.before, ntp: changed.ntp };
    assert.equal(changed.restoreUnit, restoreUnit);
    const samples = [];
    const clockDeadline = Date.now() + 45_000;
    while (Date.now() < clockDeadline) {
      ensureRunning();
      const observerBefore = await now();
      const sample = await ssh(victimNode, "clock");
      const observerAfter = await now();
      samples.push({ ...sample, t: observerAfter, observerBefore, observerAfter });
      await pause(500);
    }
    const clockEnd = await now();
    await pause(1000);
    const evidence = { before: changed.before, after: changed.after, leaseExpires: last.expires, samples,
      events: v.events.slice(), start: clockStart, end: clockEnd, pod: m.victimPod, exercised: true };
    record("clock-rollback", evidence, clockRollback, (e) => {
      const expired = e.samples.find((s) => s.mono >= e.leaseExpires + 1000);
      const event = expired && e.events.find((x) => x.t >= expired.t && x.k === "new"); if (event) event.s = 200;
    });
  } catch (error) {
    // A missing host/privilege/event is INVALID; it never disappears behind rc=0 or a later successful scenario.
    report.items.push({ id: "host-events-prerequisite-or-observation", result: "incomplete", measures: { verdict: { result: "INVALID", reason: String(error.message) } } }); save();
  } finally {
    if (restoreUnit) {
      try { report.cleanup.push({ clockRestored: await ssh(victimNode, "restore", { unit: restoreUnit, ...clockRestore }) }); }
      catch { report.cleanupFailed = true; report.cleanup.push({ clockRestored: false, watchdog: restoreUnit }); }
    }
    if (frozen) {
      try { report.cleanup.push({ thawed: await ssh(victimNode, "signal", { container: frozen, signal: "CONT" }) }); }
      catch { report.cleanupFailed = true; report.cleanup.push({ thawed: false }); }
    }
    for (const c of clients) c.child.kill("SIGTERM");
    if (clients.length && k) {
      try { await k(["-n", m.observer.namespace, "exec", m.observer.pod, "--", "sh", "-c", "pkill -f '[i]nput-type=module' || true"]); }
      catch { report.cleanupFailed = true; }
    }
    process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
    report.finishedAt = new Date().toISOString(); save();
  }
  return report.cleanupFailed || report.items.some((i) => i.result === "fail") ? 1 : report.items.some((i) => i.result !== "pass") || !report.items.length ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
