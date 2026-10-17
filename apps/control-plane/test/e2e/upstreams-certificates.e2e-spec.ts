import { X509Certificate } from "node:crypto";
import { connect, type DetailedPeerCertificate } from "node:tls";
import { describe, expect, it } from "vitest";
import { chain } from "../integration/certs.js";
import { api, compose, PROXY, publishAndConverge, type Cluster } from "./stack.js";

// P2-C1 acceptance against the live compose stack: load balancing through an upstream and TLS by SNI on the real
// gateway. Owns the agent service during the run, like the walking skeleton (the e2e config runs files serially).
const TLS_PORT = Number(process.env.KONG_PROXY_TLS_PORT ?? 8443);

/** Which backend answered: each whoami container prints its own "Hostname:". */
async function backends(path: string, n: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const res = await fetch(`${PROXY}${path}`, { signal: AbortSignal.timeout(3000) });
    const text = await res.text();
    expect(res.status).toBe(200);
    out.push(/^Hostname: (.+)$/m.exec(text)?.[1]?.trim() ?? "not whoami");
  }
  return out;
}

/** The certificate chain the gateway presents for `servername` (no verification: the chain is a test root). */
function presentedChain(servername: string): Promise<DetailedPeerCertificate[]> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: TLS_PORT, servername, rejectUnauthorized: false }, () => {
      const chainOut: DetailedPeerCertificate[] = [];
      let cert = socket.getPeerCertificate(true);
      const seen = new Set<string>();
      while (cert && cert.fingerprint256 && !seen.has(cert.fingerprint256)) {
        seen.add(cert.fingerprint256);
        chainOut.push(cert);
        cert = cert.issuerCertificate;
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

      // (a) Two whoami containers behind one upstream: the answers alternate between their hostnames.
      const upstream = await api("POST", `/environments/${envId}/upstreams`, { name: "e2e-pool.upstream" });
      expect(upstream.status, JSON.stringify(upstream.body)).toBe(201);
      const echoTarget = await api("POST", `/environments/${envId}/upstreams/${upstream.body.id}/targets`, { target: "echo:80" });
      const echo2Target = await api("POST", `/environments/${envId}/upstreams/${upstream.body.id}/targets`, { target: "echo-2:80" });
      expect([echoTarget.status, echo2Target.status]).toEqual([201, 201]);
      const svc = await api("POST", `/environments/${envId}/services`, { name: "pool", protocol: "http", host: "e2e-pool.upstream", port: 80 });
      expect((await api("POST", `/environments/${envId}/routes`, { name: "pool", serviceId: svc.body.id, paths: ["/lb"] })).status).toBe(201);
      await publishAndConverge(envId, clusterId);
      const mixed = await backends("/lb", 12);
      expect(mixed).not.toContain("not whoami");
      expect(new Set(mixed).size).toBe(2);

      // Weight 0 takes echo-2 out of the balancing: every request goes to the same container.
      expect((await api("PUT", `/environments/${envId}/upstreams/${upstream.body.id}/targets/${echo2Target.body.id}`, { target: "echo-2:80", weight: 0 })).status).toBe(200);
      await publishAndConverge(envId, clusterId);
      const pinned = await backends("/lb", 12);
      expect(new Set(pinned).size).toBe(1);
      expect(mixed).toContain(pinned[0]);

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
