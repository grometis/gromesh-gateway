import { createHash, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AtRestService } from "../../src/crypto/at-rest.js";
import { basicAuthHashContext, Encryptor, jwtSecretContext } from "../../src/crypto/crypto.js";
import { ENCRYPTION_KEYS, startHarness, uniq, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

const enc = Encryptor.fromConfig({ writeKey: ENCRYPTION_KEYS.k1, readKeys: [], fingerprintKey: ENCRYPTION_KEYS.fingerprint });
const pem = (type: "rsa" | "ec") =>
  (type === "rsa" ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : generateKeyPairSync("ec", { namedCurve: "P-256" })).publicKey.export({ type: "spki", format: "pem" }) as string;

async function consumer(api = h.api): Promise<{ envId: string; consumerId: string }> {
  const env = await api("POST", "/environments", { name: uniq("creds") });
  expect(env.status).toBe(201);
  const c = await api("POST", `/environments/${env.body.id}/consumers`, { username: uniq("partner") });
  expect(c.status).toBe(201);
  return { envId: env.body.id, consumerId: c.body.id };
}

/** What the agent protocol serves for the environment (secrets in clear, as the agent needs them). */
async function agentConfig(harness: Harness, envId: string) {
  const cluster = await harness.api("POST", `/environments/${envId}/clusters`, { name: uniq("edge") });
  const base = `${await harness.app.getUrl()}/agent/v1`;
  const registered = await fetch(`${base}/register`, {
    method: "POST",
    headers: { authorization: `Bearer ${cluster.body.registrationToken}`, "content-type": "application/json" },
    body: JSON.stringify({ nodeId: uniq("node"), hostname: "host", kongVersion: "3.9.4", agentVersion: "0.1.0" }),
  });
  const { nodeToken } = (await registered.json()) as { nodeToken: string };
  const res = await fetch(`${base}/snapshots/current`, { headers: { authorization: `Bearer ${nodeToken}` } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { config: Record<string, unknown> & Record<string, Record<string, unknown>[]> }).config;
}

/** Everything a viewer of the environment can read: none of it may carry a secret. */
async function readable(envId: string, consumerId: string): Promise<string> {
  const version = (await h.api("GET", `/environments/${envId}/snapshots?limit=1`)).body.items[0]?.version;
  return JSON.stringify([
    (await h.api("GET", `/environments/${envId}/consumers/${consumerId}/jwt`)).body,
    (await h.api("GET", `/environments/${envId}/consumers/${consumerId}/basic-auth`)).body,
    (await h.api("GET", `/environments/${envId}/publish-preview`)).body,
    (await h.api("GET", `/audit-events?environmentId=${envId}&limit=200`)).body,
    version ? (await h.api("GET", `/environments/${envId}/snapshots/${version}`)).body : null,
  ]);
}

describe("JWT credentials", () => {
  it("generates the key and an HS256 secret shown once, seals the secret, and serves it in clear only to the agent", async () => {
    const { envId, consumerId } = await consumer();
    const created = await h.api("POST", `/environments/${envId}/consumers/${consumerId}/jwt`, {});
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ consumerId, algorithm: "HS256" });
    const { secret, key } = created.body as { secret: string; key: string };
    expect(secret.length).toBeGreaterThanOrEqual(43);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    const listed = await h.api("GET", `/environments/${envId}/consumers/${consumerId}/jwt`);
    expect(listed.body.items).toEqual([{ id: created.body.id, consumerId, key, algorithm: "HS256", tags: [], createdAt: created.body.createdAt }]);

    const { rows } = await h.sql.query("select secret from jwt_credentials where id = $1", [created.body.id]);
    expect(rows[0].secret).toMatch(/^enc:v2:/);
    expect(enc.open(rows[0].secret, jwtSecretContext(created.body.id))).toBe(secret);

    const preview = await h.api("GET", `/environments/${envId}/publish-preview`);
    expect(preview.body.changes.find((c: { kind: string }) => c.kind === "jwt_secrets")).toMatchObject({ change: "added", after: { secret: "REDACTED" } });
    const published = await h.api("POST", `/environments/${envId}/snapshots`, {});
    expect(published.status).toBe(201);
    const envelope = await h.api("GET", `/environments/${envId}/snapshots/${published.body.version}`);
    expect(envelope.body.config.jwt_secrets[0]).toMatchObject({ key, secret: "REDACTED" });
    expect(envelope.body.config._transform).toBe(true);
    expect(await readable(envId, consumerId)).not.toContain(secret);
    expect((await agentConfig(h, envId)).jwt_secrets![0]).toMatchObject({ id: created.body.id, consumer: consumerId, key, algorithm: "HS256", secret });

    expect((await h.api("POST", `/environments/${envId}/consumers/${consumerId}/jwt`, { key })).status).toBe(409);
    const deleted = await h.api("DELETE", `/environments/${envId}/consumers/${consumerId}/jwt/${created.body.id}`);
    expect(deleted.status).toBe(204);
    expect((await h.api("GET", `/environments/${envId}/consumers/${consumerId}/jwt`)).body.items).toEqual([]);
    expect((await h.api("DELETE", `/environments/${envId}/consumers/${consumerId}/jwt/${created.body.id}`)).status).toBe(404);
  });

  it("verifies RS256 and ES256 with a public key, which is returned, and applies the 422 rules", async () => {
    const { envId, consumerId } = await consumer();
    const path = `/environments/${envId}/consumers/${consumerId}/jwt`;
    const paths = async (body: unknown) => {
      const res = await h.api("POST", path, body);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      return res.body.errors.map((e: { path: string }) => e.path).sort();
    };
    const rsa = pem("rsa");
    const ec = pem("ec");
    expect(await paths({ algorithm: "RS256" })).toEqual(["rsaPublicKey"]);
    expect(await paths({ algorithm: "RS256", rsaPublicKey: rsa, secret: "x".repeat(32) })).toEqual(["secret"]);
    expect(await paths({ algorithm: "HS256", rsaPublicKey: rsa })).toEqual(["rsaPublicKey"]);
    expect(await paths({ algorithm: "RS256", rsaPublicKey: "not a key" })).toEqual(["rsaPublicKey"]);
    expect(await paths({ algorithm: "RS256", rsaPublicKey: ec })).toEqual(["rsaPublicKey"]);
    expect(await paths({ algorithm: "ES256", rsaPublicKey: rsa })).toEqual(["rsaPublicKey"]);
    const priv = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    expect(await paths({ algorithm: "RS256", rsaPublicKey: priv })).toEqual(["rsaPublicKey"]);
    expect(await paths({ algorithm: "HS256", secret: "too-short" })).toEqual(["secret"]);

    const rs = await h.api("POST", path, { key: "rs-issuer", algorithm: "RS256", rsaPublicKey: rsa });
    expect(rs.status, JSON.stringify(rs.body)).toBe(201);
    expect(rs.body).toMatchObject({ key: "rs-issuer", algorithm: "RS256", rsaPublicKey: rsa });
    expect(rs.body.secret).toBeUndefined();
    const es = await h.api("POST", path, { key: "es-issuer", algorithm: "ES256", rsaPublicKey: ec });
    expect(es.status, JSON.stringify(es.body)).toBe(201);
    expect((await h.api("POST", `/environments/${envId}/snapshots`, {})).status).toBe(201);
    const served = (await agentConfig(h, envId)).jwt_secrets!;
    expect(served.find((j) => j.key === "rs-issuer")).toMatchObject({ algorithm: "RS256", rsa_public_key: rsa });
    expect(served.find((j) => j.key === "es-issuer")).toMatchObject({ algorithm: "ES256", rsa_public_key: ec });
    expect(served.every((j) => j.secret === undefined)).toBe(true);
  });
});

describe("basic-auth credentials", () => {
  it("keeps only Kong's hash, sealed, never returns the password or the hash, and serves the hash to the agent with _transform false", async () => {
    const { envId, consumerId } = await consumer();
    const password = `pw-${uniq("basic")}`;
    const hash = createHash("sha1").update(password + consumerId).digest("hex");
    const created = await h.api("POST", `/environments/${envId}/consumers/${consumerId}/basic-auth`, { username: "alice", password });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toEqual({ id: created.body.id, consumerId, username: "alice", tags: [], createdAt: created.body.createdAt });

    const { rows } = await h.sql.query("select password_hash from basicauth_credentials where id = $1", [created.body.id]);
    expect(rows[0].password_hash).toMatch(/^enc:v2:/);
    expect(rows[0].password_hash).not.toContain(hash);
    expect(enc.open(rows[0].password_hash, basicAuthHashContext(created.body.id))).toBe(hash);

    const preview = await h.api("GET", `/environments/${envId}/publish-preview`);
    expect(preview.body.changes.find((c: { kind: string }) => c.kind === "basicauth_credentials")).toMatchObject({ label: "basic-auth credential alice", after: { password: "REDACTED" } });
    const published = await h.api("POST", `/environments/${envId}/snapshots`, {});
    const envelope = await h.api("GET", `/environments/${envId}/snapshots/${published.body.version}`);
    expect(envelope.body.config._transform).toBe(false);
    expect(envelope.body.config.basicauth_credentials[0]).toMatchObject({ username: "alice", password: "REDACTED" });
    const all = await readable(envId, consumerId);
    expect(all).not.toContain(password);
    expect(all).not.toContain(hash);
    const served = await agentConfig(h, envId);
    expect(served._transform).toBe(false);
    expect(served.basicauth_credentials![0]).toEqual({ id: created.body.id, consumer: consumerId, username: "alice", password: hash, tags: ["managed-by:gromesh"] });
    const dump = await h.sql.query("select (select json_agg(t) from snapshots t where environment_id = $1)::text as s, (select json_agg(a) from audit_events a where environment_id = $1)::text as a", [envId]);
    expect(JSON.stringify(dump.rows)).not.toContain(password);
    expect(JSON.stringify(dump.rows)).not.toContain(hash);

    // Unique per environment, across consumers.
    const other = await h.api("POST", `/environments/${envId}/consumers`, { username: uniq("other") });
    expect((await h.api("POST", `/environments/${envId}/consumers/${other.body.id}/basic-auth`, { username: "alice", password })).status).toBe(409);
    expect((await h.api("POST", `/environments/${envId}/consumers/${consumerId}/basic-auth`, { username: "bob", password: "short" })).status).toBe(422);
    expect((await h.api("DELETE", `/environments/${envId}/consumers/${consumerId}/basic-auth/${created.body.id}`)).status).toBe(204);
  });
});

describe("ACL groups", () => {
  it("replaces the set, audits before and after, and emits one Kong acl per group", async () => {
    const { envId, consumerId } = await consumer();
    const path = `/environments/${envId}/consumers/${consumerId}/acl-groups`;
    expect((await h.api("GET", path)).body).toEqual({ groups: [] });
    const put = await h.api("PUT", path, { groups: ["partners", "admins"] });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toEqual({ groups: ["admins", "partners"] });
    expect((await h.api("PUT", path, { groups: ["partners"] })).status).toBe(200);
    expect((await h.api("PUT", path, { groups: ["Bad Name"] })).status).toBe(422);
    expect((await h.api("PUT", path, { groups: ["a", "a"] })).status).toBe(422);
    // Editing the consumer itself keeps its groups.
    expect((await h.api("PUT", `/environments/${envId}/consumers/${consumerId}`, { username: uniq("renamed") })).status).toBe(200);
    expect((await h.api("GET", path)).body).toEqual({ groups: ["partners"] });

    const audit = await h.api("GET", `/audit-events?environmentId=${envId}&entityType=consumer&limit=50`);
    const replaced = audit.body.items.filter((e: { action: string }) => e.action === "consumer.acl_groups.replace");
    expect(replaced.map((e: { before: unknown; after: unknown }) => [e.before, e.after])).toEqual([
      [{ groups: ["admins", "partners"] }, { groups: ["partners"] }],
      [{ groups: [] }, { groups: ["admins", "partners"] }],
    ]);
    expect((await h.api("POST", `/environments/${envId}/snapshots`, {})).status).toBe(201);
    const served = await agentConfig(h, envId);
    expect(served.acls!.map((a) => ({ consumer: a.consumer, group: a.group }))).toEqual([{ consumer: consumerId, group: "partners" }]);
    expect((await h.api("PUT", path, { groups: [] })).body).toEqual({ groups: [] });
    expect((await h.api("GET", `/environments/${envId}/consumers/${crypto.randomUUID()}/acl-groups`)).status).toBe(404);
  });
});

describe("rollback, deletion and rotation", () => {
  it("restores credentials and groups on rollback, deletes them with the consumer, and re-seals them on rotation", async () => {
    const { envId, consumerId } = await consumer();
    const base = `/environments/${envId}/consumers/${consumerId}`;
    const jwt = (await h.api("POST", `${base}/jwt`, { key: "roll-issuer" })).body;
    const basic = (await h.api("POST", `${base}/basic-auth`, { username: uniq("roll"), password: "roll-password" })).body;
    await h.api("PUT", `${base}/acl-groups`, { groups: ["gold"] });
    const v1 = await h.api("POST", `/environments/${envId}/snapshots`, {});
    expect(v1.status).toBe(201);
    await h.api("DELETE", `${base}/jwt/${jwt.id}`);
    await h.api("DELETE", `${base}/basic-auth/${basic.id}`);
    await h.api("PUT", `${base}/acl-groups`, { groups: [] });
    expect((await h.api("POST", `/environments/${envId}/snapshots`, {})).status).toBe(201);
    const rollback = await h.api("POST", `/environments/${envId}/snapshots/${v1.body.version}/rollback`);
    expect(rollback.status, JSON.stringify(rollback.body)).toBe(201);
    expect((await h.api("GET", `${base}/jwt`)).body.items.map((j: { id: string }) => j.id)).toEqual([jwt.id]);
    expect((await h.api("GET", `${base}/basic-auth`)).body.items.map((b: { id: string }) => b.id)).toEqual([basic.id]);
    expect((await h.api("GET", `${base}/acl-groups`)).body).toEqual({ groups: ["gold"] });
    const served = await agentConfig(h, envId);
    expect(served.jwt_secrets![0]!.secret).toBe(jwt.secret);
    expect(served.basicauth_credentials![0]!.password).toBe(createHash("sha1").update("roll-password" + consumerId).digest("hex"));

    const rotating = await startHarness({ encryption: { writeKey: ENCRYPTION_KEYS.k2, readKeys: [ENCRYPTION_KEYS.k1], fingerprintKey: ENCRYPTION_KEYS.fingerprint } });
    try {
      // Other test files share the database and may rotate it first: what counts is that these rows end up on k2.
      let report = await rotating.app.get(AtRestService).rotate();
      for (let i = 0; report.skipped && i < 50; i++) {
        await new Promise((r) => setTimeout(r, 100));
        report = await rotating.app.get(AtRestService).rotate();
      }
      expect(report.skipped).toBe(false);
      const sealed = await rotating.sql.query(
        "select (select secret from jwt_credentials where id = $1) as s, (select password_hash from basicauth_credentials where id = $2) as p",
        [jwt.id, basic.id],
      );
      expect(sealed.rows[0].s).toMatch(/^enc:v2:k2:/);
      expect(sealed.rows[0].p).toMatch(/^enc:v2:k2:/);
      expect((await agentConfig(rotating, envId)).jwt_secrets![0]!.secret).toBe(jwt.secret);
    } finally {
      await rotating.close();
    }

    expect((await h.api("DELETE", base)).status).toBe(204);
    const left = await h.sql.query("select (select count(*) from jwt_credentials where consumer_id = $1)::int + (select count(*) from basicauth_credentials where consumer_id = $1)::int as n", [consumerId]);
    expect(left.rows[0].n).toBe(0);
  });
});
