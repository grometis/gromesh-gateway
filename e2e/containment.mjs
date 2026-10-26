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

/** 200 | 503 | ... | "down" when nothing accepts the connection. */
async function probe(proxy) {
  try {
    const res = await fetch(`${proxy}/tvro/recarga`, { signal: AbortSignal.timeout(1500) });
    await res.arrayBuffer();
    return res.status;
  } catch {
    return "down";
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

async function leaseExpiry(harness) {
  // The writer's own view of the lease it last wrote, and of the boot clock (same kernel as the gateway).
  const { stdout } = await docker("exec", harness.writer, "sh", "-c", "cat /gromesh/isolation/lease.json; echo; cat /proc/uptime");
  const [lease, uptime] = stdout.trim().split("\n");
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

    // Loss of the lease with traffic and an open keepalive connection.
    const conn = await keepalive(proxy);
    check(conn.first === "200", `keepalive request → ${conn.first}`);
    harness.mode("stop");
    // The writer may finish one more renewal after the switch.
    await sleep(1000);
    const expiry = await leaseExpiry(harness);
    const refused = await until(proxy, (s) => s !== 200, 40_000);
    const down = await until(proxy, (s) => s === "down", 6_000);
    const after503 = refused.at === null ? null : refused.at - expiry;
    expectContained(refused.at !== null && after503 <= 1500, `requests still served ${after503 ?? "∞"} ms after the lease expired (budget C = 1 s)`);
    expectContained(down.at !== null && down.at - expiry <= 2500, `Kong still running ${down.at === null ? "∞" : down.at - expiry} ms after the lease expired (budget S + F = 2 s)`);
    await Promise.race([conn.closed, sleep(1000)]);
    expectContained(conn.closedAt() !== null, "the keepalive connection opened before the loss stayed open");
    conn.socket.destroy();
    await sleep(3000);
    expectContained((await probe(proxy)) === "down" && (await nginxProcesses(id)) === 0, "Kong restarted without a valid lease");
    console.log(`lease expired → 503 after ${Math.round(after503 ?? Infinity)} ms, Kong stopped after ${down.at === null ? "∞" : Math.round(down.at - expiry)} ms`);

    // A lease of another boot, another pod, or in violation never serves.
    for (const bad of ["other-boot", "other-pod", "violation"]) {
      harness.mode("ok");
      check((await until(proxy, (s) => s === 200, 30_000)).status === 200, `back after a valid lease (before ${bad})`);
      harness.mode(bad);
      const stopped = await until(proxy, (s) => s === "down", 6_000);
      expectContained(stopped.at !== null, `a lease with ${bad} kept Kong running (${stopped.status})`);
    }

    // The supervisor frozen: the guard alone answers 503 and the liveness fails (kubelet path, B §3.5.3).
    harness.mode("ok");
    check((await until(proxy, (s) => s === 200, 30_000)).status === 200, "back after a valid lease (before the frozen supervisor)");
    if (contained) await docker("exec", id, "kill", "-STOP", "1");
    harness.mode("stop");
    const guardOnly = await until(proxy, (s) => s === 503, 40_000);
    expectContained(guardOnly.status === 503, `with the supervisor frozen an expired lease must still get 503 (${guardOnly.status})`);
    if (contained) {
      check((await nginxProcesses(id)) > 0, "nginx keeps running while its supervisor is frozen");
      const live = await docker("exec", id, "/gromesh/bin/kong-liveness").then(() => "passed", (e) => e.stderr ?? "failed");
      check(live !== "passed" && /heartbeat|lease/.test(live), `the liveness must fail with a frozen supervisor and an expired lease: ${live}`);
      await docker("exec", id, "kill", "-CONT", "1");
      check((await until(proxy, (s) => s === "down", 6_000)).status === "down", "the resumed supervisor stops Kong");
    }

    if (failures.length > 0) throw new Error(`Containment failed:\n- ${failures.join("\n- ")}`);
    console.log("Containment holds on the real gateway: cold start, expiry with keepalive, other boot, other pod, violation, frozen supervisor");
  } finally {
    await harness.teardown();
  }
}

await main();
