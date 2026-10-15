import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// W3-X1 acceptance against a live compose stack. This test owns the agent service
// during the run and restarts Kong; run on a development/acceptance stack only.
const CP = process.env.CP_URL ?? "http://127.0.0.1:3000/api/v1";
const PROXY = process.env.KONG_PROXY_URL ?? "http://127.0.0.1:8000";
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const COMPOSE = fileURLToPath(new URL("../../../../deploy/compose/docker-compose.yml", import.meta.url));
const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Environment { id: string }
interface Service { id: string }
interface Cluster { id: string; registrationToken?: string; status: string; nodes: { appliedVersion: number | null }[] }
interface Publication { version: number }
async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(CP + path, {
    method, headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}
async function compose(args: string[], registrationToken?: string) {
  await exec("docker", ["compose", ...(process.env.COMPOSE_FILE ? [] : ["-f", COMPOSE]), ...args], {
    cwd: ROOT, timeout: 60_000,
    env: { ...process.env, ...(registrationToken ? { GROMESH_REGISTRATION_TOKEN: registrationToken } : {}) },
  });
}
async function echoWithin(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${PROXY}/echo`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
    const text = await res?.text();
    if (res?.status === 200 && text?.includes("Hostname")) return;
    await sleep(200);
  }
  throw new Error("Published /echo did not serve traffic before the deadline");
}

describe("agent distribution acceptance", () => {
  it("registers, converges within 10 s, serves /echo and boots Kong from disk without the agent", async () => {
    const env = await api<Environment>("POST", "/environments", { name: `e2e-${Date.now().toString(36)}` });
    expect(env.status).toBe(201);
    let clusterId: string | undefined;
    let agentStarted = false;
    try {
      const cluster = await api<Cluster>("POST", `/environments/${env.body.id}/clusters`, { name: "compose-edge" });
      expect(cluster.status).toBe(201);
      clusterId = cluster.body.id;
      expect(cluster.body.registrationToken).toBeTruthy();
      // Token is passed only in the child environment, never in argv or test output.
      agentStarted = true;
      await compose(["up", "-d", "--no-deps", "--force-recreate", "agent"], cluster.body.registrationToken);
      const registeredBy = Date.now() + 10_000;
      let registered = false;
      while (Date.now() < registeredBy) {
        const current = await api<Cluster>("GET", `/clusters/${clusterId}`);
        if (current.body.nodes.length) { registered = true; break; }
        await sleep(100);
      }
      expect(registered).toBe(true);
      const svc = await api<Service>("POST", `/environments/${env.body.id}/services`, { name: "echo", protocol: "http", host: "echo", port: 80 });
      expect(svc.status).toBe(201);
      expect((await api("POST", `/environments/${env.body.id}/routes`, { name: "echo", serviceId: svc.body.id, paths: ["/echo"] })).status).toBe(201);
      // Also exercises the separate validator after the data plane Admin API moves to loopback.
      expect((await api("POST", `/environments/${env.body.id}/plugins`, { name: "rate-limiting", config: { minute: 1000, policy: "local" } })).status).toBe(201);
      const published = await api<Publication>("POST", `/environments/${env.body.id}/snapshots`, { message: "agent acceptance" });
      expect(published.status).toBe(201);
      const deadline = Date.now() + 10_000;
      let converged = false;
      while (Date.now() < deadline) {
        const current = await api<Cluster>("GET", `/clusters/${clusterId}`);
        if (current.body.status === "converged" && current.body.nodes.length > 0 && current.body.nodes.every((node) => node.appliedVersion === published.body.version)) {
          converged = true; break;
        }
        await sleep(100);
      }
      expect(converged).toBe(true);
      await echoWithin(5000);
      // Disable repair before restarting: only KONG_DECLARATIVE_CONFIG can restore this route.
      await compose(["stop", "agent"]);
      agentStarted = false;
      await compose(["restart", "kong"]);
      await echoWithin(20_000);
    } finally {
      if (agentStarted) await compose(["stop", "agent"]);
      if (clusterId) await api("DELETE", `/clusters/${clusterId}`);
      await api("DELETE", `/environments/${env.body.id}`);
    }
  }, 120_000);
});
