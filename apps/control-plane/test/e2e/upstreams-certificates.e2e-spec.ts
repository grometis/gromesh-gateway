import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { connect, type PeerCertificate } from "node:tls";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { chain } from "../integration/certs.js";

// P2-C1 acceptance against the live compose stack: load balancing through an upstream and TLS by SNI on the real
// gateway. Owns the agent service during the run, like the walking skeleton (the e2e config runs files serially).
const CP = process.env.CP_URL ?? "http://127.0.0.1:3000/api/v1";
const PROXY = process.env.KONG_PROXY_URL ?? "http://127.0.0.1:8000";
const TLS_PORT = Number(process.env.KONG_PROXY_TLS_PORT ?? 8443);
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const COMPOSE = fileURLToPath(new URL("../../../../deploy/compose/docker-compose.yml", import.meta.url));
const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ADMIN = { email: process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@gromesh.dev", password: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "gromesh-dev-admin" };

interface Entity { id: string }
interface Cluster { id: string; registrationToken?: string; status: string; nodes: { appliedVersion: number | null }[] }
let session: { cookie: string; csrf: string } | null = null;

async function api<T = Entity>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  session ??= await login();
  const res = await fetch(CP + path, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), cookie: session.cookie, "x-csrf-token": session.csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

async function login(): Promise<{ cookie: string; csrf: string }> {
  const res = await fetch(`${CP}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ADMIN), signal: AbortSignal.timeout(5000) });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (res.status !== 200 || !cookie) throw new Error(`login as ${ADMIN.email} failed: HTTP ${res.status}`);
  const csrf = await fetch(`${CP}/auth/csrf`, { headers: { cookie }, signal: AbortSignal.timeout(5000) });
  return { cookie, csrf: ((await csrf.json()) as { csrfToken: string }).csrfToken };
}

async function compose(args: string[], registrationToken?: string) {
  await exec("docker", ["compose", ...(process.env.COMPOSE_FILE ? [] : ["-f", COMPOSE]), ...args], {
    cwd: ROOT,
    timeout: 60_000,
    env: { ...process.env, ...(registrationToken ? { GROMESH_REGISTRATION_TOKEN: registrationToken } : {}) },
  });
}

async function publishAndConverge(envId: string, clusterId: string) {
  const published = await api<{ version: number }>("POST", `/environments/${envId}/snapshots`, {});
  expect(published.status, JSON.stringify(published.body)).toBe(201);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const c = await api<Cluster>("GET", `/clusters/${clusterId}`);
    if (c.body.status === "converged" && c.body.nodes.length > 0 && c.body.nodes.every((n) => n.appliedVersion === published.body.version)) return;
    await sleep(200);
  }
  throw new Error(`cluster did not converge to version ${published.body.version}`);
}

/** Which backend answered: whoami prints "Hostname:", the UI's nginx serves the SPA's HTML. */
async function backends(path: string, n: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const res = await fetch(`${PROXY}${path}`, { signal: AbortSignal.timeout(3000) });
    const text = await res.text();
    expect(res.status).toBe(200);
    out.push(text.includes("Hostname:") ? "echo" : text.toLowerCase().includes("<html") ? "ui" : "other");
  }
  return out;
}

/** The certificate chain the gateway presents for `servername` (no verification: the chain is a test root). */
function presentedChain(servername: string): Promise<PeerCertificate[]> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: TLS_PORT, servername, rejectUnauthorized: false }, () => {
      const chainOut: PeerCertificate[] = [];
      let cert = socket.getPeerCertificate(true);
      const seen = new Set<string>();
      while (cert && cert.fingerprint256 && !seen.has(cert.fingerprint256)) {
        seen.add(cert.fingerprint256);
        chainOut.push(cert);
        cert = (cert as PeerCertificate & { issuerCertificate?: PeerCertificate }).issuerCertificate!;
      }
      socket.end();
      resolve(chainOut);
    });
    socket.setTimeout(5000, () => socket.destroy(new Error("TLS handshake timed out")));
    socket.on("error", reject);
  });
}

describe("upstreams and certificates on the real gateway", () => {
  it("balances across targets, honours weight 0, refuses to delete a used upstream, and serves the chain by SNI", async () => {
    const env = await api("POST", "/environments", { name: `lb-${Date.now().toString(36)}` });
    expect(env.status).toBe(201);
    const envId = env.body.id;
    let clusterId: string | undefined;
    let agentStarted = false;
    try {
      const cluster = await api<Cluster>("POST", `/environments/${envId}/clusters`, { name: "compose-lb" });
      clusterId = cluster.body.id;
      agentStarted = true;
      await compose(["up", "-d", "--no-deps", "--force-recreate", "agent"], cluster.body.registrationToken);

      // (a) Two different backends behind one upstream: the whoami echo and the UI's nginx.
      const upstream = await api("POST", `/environments/${envId}/upstreams`, { name: "e2e-pool.upstream" });
      expect(upstream.status, JSON.stringify(upstream.body)).toBe(201);
      const echoTarget = await api("POST", `/environments/${envId}/upstreams/${upstream.body.id}/targets`, { target: "echo:80" });
      const uiTarget = await api("POST", `/environments/${envId}/upstreams/${upstream.body.id}/targets`, { target: "ui:8080" });
      expect([echoTarget.status, uiTarget.status]).toEqual([201, 201]);
      const svc = await api("POST", `/environments/${envId}/services`, { name: "pool", protocol: "http", host: "e2e-pool.upstream", port: 80 });
      expect((await api("POST", `/environments/${envId}/routes`, { name: "pool", serviceId: svc.body.id, paths: ["/lb"] })).status).toBe(201);
      await publishAndConverge(envId, clusterId);
      const mixed = await backends("/lb", 12);
      expect(new Set(mixed)).toEqual(new Set(["echo", "ui"]));

      // Weight 0 takes the UI out of the balancing: every request goes to the echo.
      expect((await api("PUT", `/environments/${envId}/upstreams/${upstream.body.id}/targets/${uiTarget.body.id}`, { target: "ui:8080", weight: 0 })).status).toBe(200);
      await publishAndConverge(envId, clusterId);
      expect(new Set(await backends("/lb", 12))).toEqual(new Set(["echo"]));

      // (d) The service still uses the upstream by name: deleting it is refused and names the service.
      const del = await api<{ detail: string }>("DELETE", `/environments/${envId}/upstreams/${upstream.body.id}`);
      expect(del.status).toBe(409);
      expect(del.body.detail).toContain("pool");

      // (b, e) A leaf + intermediate chain for one SNI: the gateway presents both, leaf first, for that name.
      const c = chain("tls.e2e.test", ["tls.e2e.test"]);
      const cert = await api("POST", `/environments/${envId}/certificates`, { cert: c.cert, key: c.key, snis: ["tls.e2e.test"] });
      expect(cert.status, JSON.stringify(cert.body)).toBe(201);
      await publishAndConverge(envId, clusterId);
      const leaf = new X509Certificate(c.cert);
      const intermediate = new X509Certificate(c.cert.slice(c.cert.indexOf("-----END CERTIFICATE-----") + 25));
      const presented = await presentedChain("tls.e2e.test");
      expect(presented[0]!.fingerprint256).toBe(leaf.fingerprint256);
      expect(presented[1]?.fingerprint256).toBe(intermediate.fingerprint256);
      // Another name does not get this certificate.
      expect((await presentedChain("other.e2e.test"))[0]!.fingerprint256).not.toBe(leaf.fingerprint256);
    } finally {
      if (agentStarted) await compose(["stop", "agent"]);
      if (clusterId) await api("DELETE", `/clusters/${clusterId}`);
      await api("DELETE", `/environments/${envId}`);
    }
  }, 180_000);
});
