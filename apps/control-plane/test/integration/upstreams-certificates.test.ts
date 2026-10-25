import { X509Certificate } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { certificateKeyContext, Encryptor } from "../../src/crypto/crypto.js";
import { chain, expired, selfSigned } from "./certs.js";
import { ENCRYPTION_KEYS, startHarness, uniq, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

async function env(): Promise<string> {
  const res = await h.api("POST", "/environments", { name: uniq("lb") });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

/** What the agent protocol serves for the environment (secrets in clear, as the agent needs them). */
async function agentConfig(envId: string) {
  const cluster = await h.api("POST", `/environments/${envId}/clusters`, { name: uniq("edge") });
  const base = `${await h.app.getUrl()}/agent/v1`;
  const registered = await fetch(`${base}/register`, {
    method: "POST",
    headers: { authorization: `Bearer ${cluster.body.registrationToken}`, "content-type": "application/json" },
    body: JSON.stringify({ nodeId: uniq("node"), hostname: "host", kongVersion: "3.9.4", agentVersion: "0.1.0" }),
  });
  const { nodeToken } = (await registered.json()) as { nodeToken: string };
  const res = await fetch(`${base}/snapshots/current`, { headers: { authorization: `Bearer ${nodeToken}` } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { config: Record<string, { [k: string]: unknown }[]> }).config;
}

describe("upstreams and targets", () => {
  it("creates with defaults filled in, refuses bad hashing and duplicate names, and lists by name", async () => {
    const envId = await env();
    const created = await h.api("POST", `/environments/${envId}/upstreams`, { name: "orders.upstream", healthchecks: { active: { type: "http", httpPath: "/health" }, passive: {} } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      name: "orders.upstream",
      algorithm: "round-robin",
      hashOn: "none",
      hashFallback: "none",
      healthchecks: {
        active: { type: "http", httpPath: "/health", intervalSeconds: 10, healthyThreshold: 2, unhealthyThreshold: 3, timeoutSeconds: 1 },
        passive: { unhealthyHttpFailures: 5, unhealthyTimeouts: 3 },
      },
    });
    expect((await h.api("POST", `/environments/${envId}/upstreams`, { name: "orders.upstream" })).status).toBe(409);
    const badHash = await h.api("POST", `/environments/${envId}/upstreams`, { name: "a.upstream", algorithm: "consistent-hashing", hashOn: "header" });
    expect(badHash.status).toBe(422);
    expect(badHash.body.errors.map((e: { path: string }) => e.path)).toEqual(["hashOnHeader"]);
    const noHashing = await h.api("POST", `/environments/${envId}/upstreams`, { name: "b.upstream", hashOn: "ip" });
    expect(noHashing.body.errors.map((e: { path: string }) => e.path)).toEqual(["hashOn"]);
    expect((await h.api("POST", `/environments/${envId}/upstreams`, { name: "Not_A_Hostname" })).status).toBe(422);
    const list = await h.api("GET", `/environments/${envId}/upstreams?q=orders`);
    expect(list.body.items.map((u: { name: string }) => u.name)).toEqual(["orders.upstream"]);
  });

  it("manages targets: weight default and range, unique per upstream, port range", async () => {
    const envId = await env();
    const up = (await h.api("POST", `/environments/${envId}/upstreams`, { name: "echo.upstream" })).body;
    const t1 = await h.api("POST", `/environments/${envId}/upstreams/${up.id}/targets`, { target: "echo:80" });
    expect(t1.status, JSON.stringify(t1.body)).toBe(201);
    expect(t1.body).toMatchObject({ upstreamId: up.id, target: "echo:80", weight: 100 });
    expect((await h.api("POST", `/environments/${envId}/upstreams/${up.id}/targets`, { target: "echo:80" })).status).toBe(409);
    expect((await h.api("POST", `/environments/${envId}/upstreams/${up.id}/targets`, { target: "echo:70000" })).body.errors[0].path).toBe("target");
    expect((await h.api("POST", `/environments/${envId}/upstreams/${up.id}/targets`, { target: "no-port" })).status).toBe(422);
    expect((await h.api("POST", `/environments/${envId}/upstreams/${up.id}/targets`, { target: "[2001:db8::1]:8080", weight: 0 })).status).toBe(201);
    const put = await h.api("PUT", `/environments/${envId}/upstreams/${up.id}/targets/${t1.body.id}`, { target: "echo:80", weight: 7 });
    expect(put.body.weight).toBe(7);
    const list = await h.api("GET", `/environments/${envId}/upstreams/${up.id}/targets`);
    expect(list.body.items.map((t: { target: string }) => t.target)).toEqual(["[2001:db8::1]:8080", "echo:80"]);
    expect((await h.api("DELETE", `/environments/${envId}/upstreams/${up.id}/targets/${t1.body.id}`)).status).toBe(204);
  });

  it("refuses to delete or rename an upstream that services use as host, naming them; DNS hosts stay valid", async () => {
    const envId = await env();
    const up = (await h.api("POST", `/environments/${envId}/upstreams`, { name: "pool.upstream" })).body;
    // A service may point at a name that is no upstream: it is ordinary DNS.
    expect((await h.api("POST", `/environments/${envId}/services`, { name: "dns", protocol: "http", host: "no-such.upstream", port: 80 })).status).toBe(201);
    for (const name of ["orders", "billing"]) {
      expect((await h.api("POST", `/environments/${envId}/services`, { name, protocol: "http", host: "pool.upstream", port: 80 })).status).toBe(201);
    }
    const del = await h.api("DELETE", `/environments/${envId}/upstreams/${up.id}`);
    expect(del.status).toBe(409);
    expect(del.body.detail).toContain("billing, orders");
    const rename = await h.api("PUT", `/environments/${envId}/upstreams/${up.id}`, { name: "other.upstream" });
    expect(rename.status).toBe(409);
    expect(rename.body.detail).toContain("billing, orders");
    // Same name, other settings: allowed.
    expect((await h.api("PUT", `/environments/${envId}/upstreams/${up.id}`, { name: "pool.upstream", algorithm: "least-connections" })).status).toBe(200);
  });

  it("publishes upstreams and targets to the agent, and the audit log records every change", async () => {
    const envId = await env();
    const up = (await h.api("POST", `/environments/${envId}/upstreams`, { name: "echo.upstream" })).body;
    const target = (await h.api("POST", `/environments/${envId}/upstreams/${up.id}/targets`, { target: "echo:80", weight: 3 })).body;
    expect((await h.api("POST", `/environments/${envId}/snapshots`, {})).status).toBe(201);
    const config = await agentConfig(envId);
    expect(config.upstreams).toEqual([expect.objectContaining({ id: up.id, name: "echo.upstream", algorithm: "round-robin", tags: ["managed-by:gromesh"] })]);
    expect(config.targets).toEqual([expect.objectContaining({ id: target.id, upstream: up.id, target: "echo:80", weight: 3 })]);
    const audit = await h.api("GET", `/audit-events?environmentId=${envId}&limit=50`);
    expect(audit.body.items.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["upstream.create", "target.create"]));
  });
});

describe("certificates", () => {
  it("accepts a chain, describes the leaf, keeps the key write-only and sealed, and serves it in clear only to the agent", async () => {
    const envId = await env();
    const c = chain("api.example.test", ["api.example.test", "*.example.test"]);
    const created = await h.api("POST", `/environments/${envId}/certificates`, { cert: c.cert, key: c.key, snis: ["api.example.test", "*.example.test"] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const leaf = new X509Certificate(c.cert);
    expect(created.body).toMatchObject({
      key: "REDACTED",
      snis: ["*.example.test", "api.example.test"],
      subject: "CN=api.example.test",
      issuer: "CN=Gromesh Test Intermediate",
      notAfter: leaf.validToDate.toISOString(),
      fingerprintSha256: leaf.fingerprint256,
    });
    expect(JSON.stringify((await h.api("GET", `/environments/${envId}/certificates/${created.body.id}`)).body)).not.toContain(c.key.split("\n")[1]!);
    const { rows } = await h.sql.query("select key from certificates where id = $1", [created.body.id]);
    expect(rows[0].key).toMatch(/^enc:v2:/);
    const preview = await h.api("GET", `/environments/${envId}/publish-preview`);
    expect(preview.status).toBe(200);
    expect(preview.body.changes.find((c: { kind: string }) => c.kind === "certificates")?.after.key).toBe("REDACTED");
    expect(JSON.stringify(preview.body)).not.toContain(c.key.split("\n")[1]!);
    const published = await h.api("POST", `/environments/${envId}/snapshots`, {});
    expect(published.status).toBe(201);
    const envelope = await h.api("GET", `/environments/${envId}/snapshots/${published.body.version}`);
    expect(envelope.body.config.certificates[0].key).toBe("REDACTED");
    const audit = await h.api("GET", `/audit-events?environmentId=${envId}&entityType=certificate`);
    expect(JSON.stringify(audit.body)).not.toContain(c.key.split("\n")[1]!);
    const config = await agentConfig(envId);
    expect(config.certificates![0]).toMatchObject({ id: created.body.id, cert: c.cert, key: c.key });
    expect((config.snis as { name: string; certificate: string }[]).map((s) => s.name).sort()).toEqual(["*.example.test", "api.example.test"]);
  });

  it("applies the 422 rules (PEM, key mismatch, REDACTED on creation, expired leaf, repeated SNIs) and the 409 of a taken SNI", async () => {
    const envId = await env();
    const a = selfSigned("a.example.test");
    const b = selfSigned("b.example.test");
    const paths = async (body: unknown) => {
      const res = await h.api("POST", `/environments/${envId}/certificates`, body);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      return res.body.errors.map((e: { path: string }) => e.path).sort();
    };
    expect(await paths({ cert: "not a pem", key: a.key, snis: [] })).toEqual(["cert"]);
    expect(await paths({ cert: a.cert, key: "not a key", snis: [] })).toEqual(["key"]);
    expect(await paths({ cert: a.cert, key: b.key, snis: [] })).toEqual(["key"]);
    expect(await paths({ cert: a.cert, key: "REDACTED", snis: [] })).toEqual(["key"]);
    const old = expired("old.example.test");
    expect(await paths({ cert: old.cert, key: old.key, snis: [] })).toEqual(["cert"]);
    expect(await paths({ cert: a.cert, key: a.key, snis: ["a.example.test", "a.example.test"] })).toEqual(["snis.1"]);
    expect(await paths({ cert: a.cert, key: a.key, snis: ["foo.*.example.test"] })).toEqual(["snis.0"]);
    expect((await h.api("POST", `/environments/${envId}/certificates`, { cert: a.cert, key: a.key, snis: ["a.example.test"] })).status).toBe(201);
    // A name another certificate holds, in this environment or any other, is the generic conflict (decision H-5).
    const taken = await h.api("POST", `/environments/${envId}/certificates`, { cert: b.cert, key: b.key, snis: ["b.example.test", "a.example.test"] });
    expect(taken.status).toBe(409);
    expect(taken.body.detail).toBe("Already in use in this instance");
  });

  it("keeps the key with REDACTED on a PUT, judges expiry only when cert changes, and survives a rollback", async () => {
    const envId = await env();
    const a = selfSigned("keep.example.test");
    const created = (await h.api("POST", `/environments/${envId}/certificates`, { cert: a.cert, key: a.key, snis: ["keep.example.test"] })).body;
    const kept = await h.api("PUT", `/environments/${envId}/certificates/${created.id}`, { cert: a.cert, key: "REDACTED", snis: ["keep.example.test", "also.example.test"] });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body.snis).toEqual(["also.example.test", "keep.example.test"]);
    // A new cert with REDACTED must still match the stored key.
    const other = selfSigned("other.example.test");
    expect((await h.api("PUT", `/environments/${envId}/certificates/${created.id}`, { cert: other.cert, key: "REDACTED", snis: [] })).body.errors[0].path).toBe("key");

    // A certificate that expired after it was stored: editing only its SNIs, publishing and rolling back still work.
    const old = expired("old.example.test");
    const enc = Encryptor.fromConfig({ writeKey: ENCRYPTION_KEYS.k1, readKeys: [], fingerprintKey: ENCRYPTION_KEYS.fingerprint });
    await h.sql.query("update certificates set cert = $1, key = $2, not_after = '2020-01-02T00:00:00Z' where id = $3", [old.cert, enc.seal(old.key, certificateKeyContext(created.id)), created.id]);
    const v1 = await h.api("POST", `/environments/${envId}/snapshots`, {});
    expect(v1.status).toBe(201);
    const snisOnly = await h.api("PUT", `/environments/${envId}/certificates/${created.id}`, { cert: old.cert, key: old.key, snis: ["old.example.test"] });
    expect(snisOnly.status, JSON.stringify(snisOnly.body)).toBe(200);
    expect((await h.api("PUT", `/environments/${envId}/certificates/${created.id}`, { cert: old.cert + "\n", key: old.key, snis: [] })).body.errors[0].path).toBe("cert");
    expect((await h.api("POST", `/environments/${envId}/snapshots`, {})).status).toBe(201);
    const rollback = await h.api("POST", `/environments/${envId}/snapshots/${v1.body.version}/rollback`);
    expect(rollback.status, JSON.stringify(rollback.body)).toBe(201);
    const restored = await h.api("GET", `/environments/${envId}/certificates/${created.id}`);
    expect(restored.body.snis).toEqual(["also.example.test", "keep.example.test"]);
    const { rows } = await h.sql.query("select key from certificates where id = $1", [created.id]);
    expect(rows[0].key).toMatch(/^enc:v2:/);
  });
});
