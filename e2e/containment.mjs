#!/usr/bin/env node
// N2-D1 against the real Kong 3.9.4 image: the gateway of a Workspace serves only with a valid isolation lease.
// kong-supervisor is PID 1 and the route guard checks the lease on every request; test-lease-writer stands in for the
// isolation-probe. Measured from the moment the lease stops being valid: 503 to new requests, Kong stopped by the
// supervisor (an open keepalive connection closed with it), no restart without a lease, and with the supervisor
// frozen the guard alone still answers 503 and the liveness fails. CONTAINMENT=off is the negative control: the guard
// ignores the lease and nothing supervises Kong, so the same checks must fail.
import assert from "node:assert/strict";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { docker, Harness, root } from "./isolation-harness.mjs";

const { composeWorkspaces } = await import(pathToFileURL(join(root, "packages/compiler/dist/index.js")).href);
const contained = process.env.CONTAINMENT !== "off";
const failures = [];
const expectContained = (ok, message) => { if (!ok) failures.push(message); };
const check = (ok, message) => assert.ok(ok, message);

const config = composeWorkspaces([{
  id: "00000000-0000-4000-8000-00000000a001",
  slug: "tvro",
  state: {
    services: [{ id: "6a1f3c2e-0b7d-4c1a-9f10-a00000000001", name: "echo", protocol: "http", host: "echo", port: 80 }],
    routes: [{ id: "6a1f3c2e-0b7d-4c1a-9f10-a00000000002", name: "recarga", serviceId: "6a1f3c2e-0b7d-4c1a-9f10-a00000000001", paths: ["/recarga"] }],
    consumers: [],
    keyAuthCredentials: [],
    plugins: [],
  },
}]);

/**
 * 200 | 503 | ... ; "down" when the connection is refused or closed without an answer (Docker's port proxy accepts
 * and closes when nothing listens behind it); "timeout" when nothing answered in time, which proves nothing.
 */
async function probe(proxy) {
  try {
    const res = await fetch(`${proxy}/tvro/recarga`, { signal: AbortSignal.timeout(1500) });
    await res.arrayBuffer();
    return res.status;
  } catch (error) {
    return error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "down";
  }
}

/** A keepalive connection with one answered request; resolves `closed` when the gateway closes it. */
function keepalive(proxy) {
  const { hostname, port } = new URL(proxy);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname);
    let closedAt = null;
    const closed = new Promise((done) => socket.on("close", () => { closedAt = Date.now(); done(closedAt); }));
    socket.once("data", (chunk) => resolve({ first: chunk.toString().split(" ")[1], closed, closedAt: () => closedAt, socket }));
    socket.on("error", () => {});
    socket.on("connect", () => socket.write(`GET /tvro/recarga HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n`));
    setTimeout(() => reject(new Error("keepalive request unanswered")), 5000);
  });
}

/** Polls the container's PID namespace until no nginx process is left; returns when, or null. */
async function nginxGone(id, timeoutMs) {
  const began = Date.now();
  for (;;) {
    if ((await nginxProcesses(id)) === 0) return Date.now();
    if (Date.now() - began > timeoutMs) return null;
    await sleep(50);
  }
}

async function heartbeat(id) {
  const { stdout } = await docker("exec", id, "cat", "/gromesh/kong-state/kong-state.json");
  return JSON.parse(stdout).heartbeatBoottimeNs;
}

async function nginxProcesses(id) {
  const { stdout } = await docker("exec", id, "sh", "-c", "cat /proc/[0-9]*/comm 2>/dev/null | grep -c '^nginx$' || true");
  return Number(stdout.trim());
}

/** Polls until the status changes from `from`; returns the time and every status seen. */
async function until(proxy, ok, timeoutMs) {
  const began = Date.now();
  for (;;) {
    const status = await probe(proxy);
    if (ok(status)) return { at: Date.now(), status, waited: Date.now() - began };
    if (Date.now() - began > timeoutMs) return { at: null, status, waited: Date.now() - began };
    await sleep(100);
  }
}

/** After mode("ok"): wait for a valid lease newer than the switch (the negative control serves without one). */
async function freshLease(harness) {
  const after = Date.now();
  await harness.waitFor("a fresh valid lease", async () => {
    const { stdout } = await docker("exec", harness.writer, "cat", "/gromesh/isolation/lease.json");
    const lease = JSON.parse(stdout);
    return lease.state === "ok" && Date.parse(lease.issuedAt) >= Math.floor(after / 1000) * 1000;
  }, { timeoutMs: 10_000 });
}

async function leaseExpiry(harness) {
  // The writer's own view of the lease it last wrote, and of the boot clock (same kernel as the gateway).
  // Until the writer has replaced a deliberately malformed document of a previous step.
  let lease, uptime;
  for (let attempt = 0; ; attempt++) {
    const { stdout } = await docker("exec", harness.writer, "sh", "-c", "cat /gromesh/isolation/lease.json; echo; cat /proc/uptime");
    [lease, uptime] = stdout.trim().split("\n");
    try {
      if (JSON.parse(lease).state === "ok") break;
    } catch { /* not yet */ }
    if (attempt > 30) throw new Error(`no valid lease to measure from: ${lease}`);
    await sleep(100);
  }
  const { expiresBoottimeNs } = JSON.parse(lease);
  const nowNs = Math.round(Number(uptime.split(" ")[0]) * 1e9);
  return Date.now() + (expiresBoottimeNs - nowNs) / 1e6;
}

async function main() {
  const harness = new Harness();
  try {
    await harness.setup();
    let pluginsDir;
    if (!contained) {
      // The guard with its lease check removed: a copy of the plugins, patched for the negative control only.
      pluginsDir = join(harness.dir, "plugins");
      cpSync(join(root, "images/kong/plugins"), pluginsDir, { recursive: true });
      const handler = join(pluginsDir, "kong/plugins/gromesh-route-guard/handler.lua");
      writeFileSync(handler, readFileSync(handler, "utf8").replace("local current, err = lease.current(conf.lease_file)", "local current, err = true, nil"));
    }
    // The guard's lease parser, run by the LuaJIT of the real image.
    await docker("run", "--rm", "-v", `${join(root, "images/kong/plugins")}:/plugins:ro`, "-v", `${join(root, "e2e/lua")}:/t:ro`,
      "--entrypoint", "/usr/local/openresty/luajit/bin/luajit", harness.kongImage, "/t/lease-parse.lua");
    const { id, proxy } = await harness.gateway(config, { supervised: contained, pluginsDir });

    // Cold start without a lease: no nginx, no listener.
    await sleep(4000);
    if (contained) {
      check((await probe(proxy)) === "down" && (await nginxProcesses(id)) === 0, "nginx must not start without a lease");
    }
    harness.mode("ok");
    const up = await until(proxy, (s) => s === 200, 30_000);
    check(up.status === 200, `the gateway must serve once the lease is valid (${up.status})`);

    await harness.waitFor("the first lease", async () => (await docker("exec", harness.writer, "test", "-s", "/gromesh/isolation/lease.json"), true));

    // Loss of the lease with traffic and an open keepalive connection; every milestone measured from the expiry the
    // writer observed in the node's CLOCK_BOOTTIME.
    const conn = await keepalive(proxy);
    check(conn.first === "200", `keepalive request → ${conn.first}`);
    harness.mode("stop");
    // The writer may finish one more renewal after the switch.
    await sleep(1000);
    const expiry = await leaseExpiry(harness);
    const refused = await until(proxy, (s) => s !== 200, 40_000);
    const gone = await nginxGone(id, 8_000);
    const since = (t) => (t === null ? Infinity : Math.round(t - expiry));
    // The contract's budgets plus only the measurement's own uncertainty: the polling interval and /proc/uptime's 10 ms.
    const SLACK = 150;
    // Supervised, Kong may already be gone at the first sample after the expiry: a refused request is either 503 or
    // no gateway at all. The 503 of the guard alone is proven below, with the supervisor frozen.
    expectContained((refused.status === 503 || refused.status === "down") && since(refused.at) <= 1000 + SLACK, `requests still served ${since(refused.at)} ms after the lease expired, then ${refused.status} (budget C = 1 s)`);
    expectContained(since(gone) <= 2000 + SLACK, `Kong still running ${since(gone)} ms after the lease expired (budget S + F = 2 s)`);
    await Promise.race([conn.closed, sleep(2500)]);
    expectContained(since(conn.closedAt()) <= 2000 + SLACK, `the keepalive connection opened before the loss stayed open ${since(conn.closedAt())} ms after the expiry`);
    conn.socket.destroy();
    await sleep(3000);
    expectContained((await probe(proxy)) === "down" && (await nginxProcesses(id)) === 0, "Kong restarted without a valid lease");
    console.log(`lease expired → 503 after ${since(refused.at)} ms, every nginx process gone after ${since(gone)} ms, keepalive closed after ${since(conn.closedAt())} ms`);

    // A lease of another boot, another pod, in violation, or that no strict reader may accept never serves.
    for (const bad of ["other-boot", "other-pod", "violation", "duplicate-state", "trailing-data"]) {
      harness.mode("ok");
      await freshLease(harness);
      check((await until(proxy, (s) => s === 200, 30_000)).status === 200, `back after a valid lease (before ${bad})`);
      const switched = Date.now();
      harness.mode(bad);
      const stoppedAt = await nginxGone(id, 6_000);
      expectContained(stoppedAt !== null, `a lease with ${bad} kept Kong running`);
      if (stoppedAt !== null) console.log(`${bad}: Kong stopped ${stoppedAt - switched} ms after the writer switched`);
    }

    // The supervisor frozen from the daemon (an ancestor PID namespace: inside the container PID 1 ignores SIGSTOP).
    harness.mode("ok");
    await freshLease(harness);
    check((await until(proxy, (s) => s === 200, 30_000)).status === 200, "back after a valid lease (before the frozen supervisor)");
    if (contained) {
      await docker("kill", "--signal", "STOP", id);
      const beat = await heartbeat(id);
      await sleep(4000);
      check((await heartbeat(id)) === beat, "the supervisor must really be frozen: its heartbeat moved");
      // Lease still valid, heartbeat stale: the liveness alone fails.
      const live = await docker("exec", id, "/gromesh/bin/kong-liveness").then(() => "passed", (e) => e.stderr ?? "failed");
      check(/heartbeat/.test(live), `with a valid lease and a frozen supervisor the liveness must fail on the heartbeat: ${live}`);
    }
    harness.mode("stop");
    await sleep(1000);
    const frozenExpiry = await leaseExpiry(harness);
    const guardOnly = await until(proxy, (s) => s !== 200, 40_000);
    const guardAfter = guardOnly.at === null ? Infinity : Math.round(guardOnly.at - frozenExpiry);
    expectContained(guardOnly.status === 503 && guardAfter <= 1000 + 150, `with the supervisor frozen an expired lease must get 503 within 1 s: ${guardOnly.status} after ${guardAfter} ms`);
    if (contained) {
      check((await nginxProcesses(id)) > 0, "nginx keeps running while its supervisor is frozen");
      await docker("kill", "--signal", "CONT", id);
      check((await nginxGone(id, 6_000)) !== null, "the resumed supervisor stops Kong");
    }

    if (failures.length > 0) throw new Error(`Containment failed:\n- ${failures.join("\n- ")}`);
    console.log("Containment holds on the real gateway: cold start, expiry with keepalive, other boot, other pod, violation, frozen supervisor");
  } finally {
    await harness.teardown();
  }
}

await main();
