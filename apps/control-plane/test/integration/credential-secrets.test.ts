import { generateKeyPairSync } from "node:crypto";
import type { KongDeclarativeConfig } from "@gromesh/compiler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contracts } from "../../src/common/contract.js";
import { freshKey } from "../../src/consumers/consumers.js";
import { credentialContext, ENCRYPTOR, type Encryptor, snapshotContext } from "../../src/crypto/crypto.js";
import { DB, type Db } from "../../src/db/db.js";
import { type ApiClient, startHarness, uniq, type Harness } from "./harness.js";

// N1-X6 (decision H-14): only the server generates a key-auth key or an HS256 secret, shown once on creation or
// rotation; an import brings a new one in with its metadata only, pending reprovisioning, out of the config until an
// editor rotates it. RS256/ES256, the JWT key (iss) and basic-auth are as before.
let h: Harness;
let enc: Encryptor;
beforeAll(async () => {
  h = await startHarness();
  enc = h.app.get<Encryptor>(ENCRYPTOR);
});
afterAll(async () => {
  await h?.close();
});

const KEY = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url
const v2 = (client: ApiClient, method: string, path: string, body?: unknown) => client(method, `/../v2${path}`, body);
const rsa = () => generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }) as string;

async function workspace() {
  const env = await h.api("POST", "/environments", { name: uniq("h14") });
  const consumer = await h.api("POST", `/environments/${env.body.id}/consumers`, { username: uniq("app") });
  return { envId: env.body.id as string, consumerId: consumer.body.id as string, base: `/environments/${env.body.id}/consumers/${consumer.body.id}` };
}
/** Publishes the draft and returns the config the gateway gets. */
async function published(envId: string): Promise<KongDeclarativeConfig> {
  const res = await h.api("POST", `/environments/${envId}/snapshots`, {});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const [row] = (await h.sql.query("select config from snapshots where environment_id = $1 and version = $2", [envId, res.body.version])).rows;
  return enc.openJson<KongDeclarativeConfig>(row.config, snapshotContext(envId, res.body.version, "config"));
}
const audit = async (envId: string) => JSON.stringify((await h.sql.query("select action, before, after from audit_events where environment_id = $1", [envId])).rows);

describe("keys and HS256 secrets only from the server", () => {
  it("generates them from the CSPRNG, distinct, and shows each only in the response that created it", async () => {
    const { base } = await workspace();
    const keys = new Set<string>();
    const secrets = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const k = await h.api("POST", `${base}/key-auth`, {});
      expect(k.status).toBe(201);
      expect(k.body.key).toMatch(KEY);
      keys.add(k.body.key);
      const j = await h.api("POST", `${base}/jwt`, {});
      expect(j.status).toBe(201);
      expect(j.body.secret).toMatch(KEY);
      secrets.add(j.body.secret);
    }
    expect(keys.size).toBe(20);
    expect(secrets.size).toBe(20);
    const listed = JSON.stringify([(await h.api("GET", `${base}/key-auth`)).body, (await h.api("GET", `${base}/jwt`)).body]);
    for (const value of [...keys, ...secrets]) expect(listed).not.toContain(value);
  });

  it("refuses a supplied key or secret at its field, in v1 and v2, and on a rotation", async () => {
    const { envId, consumerId, base } = await workspace();
    const at = (res: { status: number; body: { errors?: { path: string }[] } }, path: string) => {
      expect(res.status).toBe(422);
      expect(res.body.errors?.map((e) => e.path)).toEqual([path]);
    };
    at(await h.api("POST", `${base}/key-auth`, { key: "a-key-the-operator-chose-0123" }), "key");
    at(await v2(h.api, "POST", `/workspaces/${envId}/consumers/${consumerId}/key-auth`, { key: "a-key-the-operator-chose-0123" }), "key");
    at(await h.api("POST", `${base}/jwt`, { secret: "a-secret-the-operator-chose-0123456789" }), "secret");
    at(await v2(h.api, "POST", `/workspaces/${envId}/consumers/${consumerId}/jwt`, { algorithm: "HS256", secret: "a-secret-the-operator-chose-0123456789" }), "secret");
    const k = (await h.api("POST", `${base}/key-auth`, {})).body;
    const j = (await h.api("POST", `${base}/jwt`, {})).body;
    at(await h.api("POST", `${base}/key-auth/${k.id}/rotate`, { key: "a-key-the-operator-chose-0123" }), "key");
    at(await v2(h.api, "POST", `/workspaces/${envId}/consumers/${consumerId}/jwt/${j.id}/rotate`, { secret: "a-secret-the-operator-chose-0123456789" }), "secret");
    expect((await h.api("GET", `${base}/key-auth`)).body.items).toHaveLength(1);
  });

  it("draws a key again when the one drawn is already held anywhere in the instance", async () => {
    const { base } = await workspace();
    const held = (await h.api("POST", `${base}/key-auth`, {})).body.key as string;
    const draws = [held, held, "a-fresh-key-nobody-holds-0123456789abcdefg"];
    const drawn = await h.app.get<Db>(DB).transaction((tx) => freshKey(tx, enc, () => draws.shift()!));
    expect(drawn).toBe("a-fresh-key-nobody-holds-0123456789abcdefg");
    await expect(h.app.get<Db>(DB).transaction((tx) => freshKey(tx, enc, () => held))).rejects.toThrow(/Could not draw/);
  });
});

describe("rotation", () => {
  it("replaces the key in place, shows the new one once, audits only hints, and Kong gets the new one", async () => {
    const { envId, base } = await workspace();
    const created = (await h.api("POST", `${base}/key-auth`, {})).body;
    const rotated = await h.api("POST", `${base}/key-auth/${created.id}/rotate`);
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    expect(rotated.body).toMatchObject({ id: created.id, status: "active", keyHint: `…${rotated.body.key.slice(-4)}` });
    expect(rotated.body.key).toMatch(KEY);
    expect(rotated.body.key).not.toBe(created.key);
    const config = await published(envId);
    expect(config.keyauth_credentials.map((k) => k.key)).toEqual([rotated.body.key]);
    const trail = await audit(envId);
    expect(trail).toContain("keyauth.rotate");
    expect(trail).not.toContain(created.key);
    expect(trail).not.toContain(rotated.body.key);
  });

  it("rotates an HS256 secret, keeps its key (iss), and refuses an RS256 one (its public key is the client's)", async () => {
    const { envId, base } = await workspace();
    const hs = (await h.api("POST", `${base}/jwt`, { key: uniq("iss") })).body;
    const rotated = await h.api("POST", `${base}/jwt/${hs.id}/rotate`);
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    expect(rotated.body).toMatchObject({ id: hs.id, key: hs.key, algorithm: "HS256", status: "active" });
    expect(rotated.body.secret).not.toBe(hs.secret);
    const rs = (await h.api("POST", `${base}/jwt`, { key: uniq("rs"), algorithm: "RS256", rsaPublicKey: rsa() })).body;
    expect((await h.api("POST", `${base}/jwt/${rs.id}/rotate`)).status).toBe(409);
    const config = await published(envId);
    expect(config.jwt_secrets?.find((j) => j.id === hs.id)?.secret).toBe(rotated.body.secret);
    const trail = await audit(envId);
    expect(trail).toContain("jwt.rotate");
    for (const secret of [hs.secret, rotated.body.secret]) expect(trail).not.toContain(secret);
  });

  it("reaches no credential of another consumer or workspace, and only an editor may rotate", async () => {
    const a = await workspace();
    const b = await workspace();
    const k = (await h.api("POST", `${a.base}/key-auth`, {})).body;
    const j = (await h.api("POST", `${a.base}/jwt`, {})).body;
    for (const path of [`${b.base}/key-auth/${k.id}/rotate`, `/environments/${a.envId}/consumers/${b.consumerId}/key-auth/${k.id}/rotate`, `${b.base}/jwt/${j.id}/rotate`]) {
      expect((await h.api("POST", path)).status, path).toBe(404);
    }
    expect((await v2(h.api, "POST", `/workspaces/${b.envId}/consumers/${a.consumerId}/key-auth/${k.id}/rotate`)).status).toBe(404);
    const viewer = await h.as("viewer");
    expect((await viewer.api("POST", `${a.base}/key-auth/${k.id}/rotate`)).status).toBe(403);
    expect((await v2(viewer.api, "POST", `/workspaces/${a.envId}/consumers/${a.consumerId}/jwt/${j.id}/rotate`)).status).toBe(403);
    const token = (await h.api("POST", "/users/me/tokens", { name: uniq("ro"), role: "viewer", expiresInDays: 1 })).body.token as string;
    expect((await h.anonymous("POST", `${a.base}/key-auth/${k.id}/rotate`, undefined, { authorization: `Bearer ${token}` })).status).toBe(403);
    expect((await h.anonymous("POST", `${a.base}/key-auth/${k.id}/rotate`)).status).toBe(401);
    // Nothing changed: the key is the one created.
    const [row] = (await h.sql.query("select key from keyauth_credentials where id = $1", [k.id])).rows;
    expect(enc.open(row.key, credentialContext(k.id))).toBe(k.key);
  });
});

describe("import without a usable secret", () => {
  const document = (key: string, secret: string, iss: string) => ({
    apiVersion: "gromesh/v1",
    services: [],
    routes: [],
    consumers: [{ username: "migrated", tags: [], aclGroups: [], keyAuthCredentials: [{ key, tags: ["from-doc"] }], jwtCredentials: [{ key: iss, algorithm: "HS256", secret, tags: [] }, { key: `${iss}-rs`, algorithm: "RS256", rsaPublicKey: rsa(), tags: [] }], basicAuthCredentials: [] }],
    plugins: [],
    upstreams: [],
    certificates: [],
  });

  it("imports the metadata only, pending reprovisioning: listed without a value, out of the config, until rotated", async () => {
    const { envId } = await workspace();
    const key = `doc-key-${uniq("k")}-0123456789`;
    const secret = `doc-secret-${"s".repeat(32)}`;
    const iss = uniq("iss");
    const body = { document: document(key, secret, iss), mode: "merge" };
    // A dry run lists them and writes nothing.
    const dry = await h.api("POST", `/environments/${envId}/import`, { ...body, dryRun: true });
    expect(dry.status, JSON.stringify(dry.body)).toBe(200);
    expect(dry.body.pendingCredentials.map((p: { path: string }) => p.path)).toEqual(["document.consumers.0.keyAuthCredentials.0", "document.consumers.0.jwtCredentials.0"]);
    expect((await h.sql.query("select count(*)::int as n from keyauth_credentials where environment_id = $1", [envId])).rows[0].n).toBe(0);

    const real = await h.api("POST", `/environments/${envId}/import`, { ...body, dryRun: false });
    expect(real.status, JSON.stringify(real.body)).toBe(200);
    expect(contracts.validator("EnvironmentImportReport")(structuredClone(real.body))).toBe(true);
    expect(real.body.pendingCredentials).toEqual([
      { path: "document.consumers.0.keyAuthCredentials.0", credentialType: "key-auth", credentialId: expect.any(String) },
      { path: "document.consumers.0.jwtCredentials.0", credentialType: "jwt", credentialId: expect.any(String) },
    ]);
    const [pendingKey, pendingJwt] = real.body.pendingCredentials.map((p: { credentialId: string }) => p.credentialId);
    const consumerId = (await h.api("GET", `/environments/${envId}/consumers`)).body.items.find((c: { username: string }) => c.username === "migrated").id as string;
    const base = `/environments/${envId}/consumers/${consumerId}`;
    expect((await h.api("GET", `${base}/key-auth`)).body.items).toEqual([expect.objectContaining({ id: pendingKey, status: "pending-reprovision", keyHint: null, tags: ["from-doc"] })]);
    const jwts = (await h.api("GET", `${base}/jwt`)).body.items;
    expect(jwts.find((j: { id: string }) => j.id === pendingJwt)).toMatchObject({ key: iss, status: "pending-reprovision" });
    expect(jwts.find((j: { algorithm: string }) => j.algorithm === "RS256")).toMatchObject({ status: "active" });
    // The document's values were never stored, and nothing about them leaves the service.
    const [row] = (await h.sql.query("select key, key_hash from keyauth_credentials where id = $1", [pendingKey])).rows;
    expect(enc.open(row.key, credentialContext(pendingKey))).not.toBe(key);
    expect(row.key_hash).not.toBe(enc.fingerprint(key));
    expect((await h.sql.query("select secret from jwt_credentials where id = $1", [pendingJwt])).rows[0].secret).toBe(null);
    const exported = await h.api("GET", `/environments/${envId}/export?format=json`);
    expect(contracts.validator("GromeshConfigV1Export")(structuredClone(exported.body))).toBe(true);
    expect(exported.body.consumers[0].keyAuthCredentials).toEqual([{ id: pendingKey, status: "pending-reprovision", tags: ["from-doc"] }]);
    for (const shown of [JSON.stringify(real.body), JSON.stringify(exported.body), await audit(envId)]) {
      expect(shown).not.toContain(key);
      expect(shown).not.toContain(secret);
    }
    expect(await audit(envId)).toContain(pendingKey);

    // Out of the config: they authenticate nothing.
    const before = await published(envId);
    expect(before.keyauth_credentials).toEqual([]);
    expect(before.jwt_secrets?.map((j) => j.algorithm)).toEqual(["RS256"]);

    // Reprovisioned by an editor: active, in the config with the generated values.
    const k = await h.api("POST", `${base}/key-auth/${pendingKey}/rotate`);
    const j = await h.api("POST", `${base}/jwt/${pendingJwt}/rotate`);
    expect([k.status, j.status]).toEqual([200, 200]);
    expect(k.body).toMatchObject({ status: "active", keyHint: `…${k.body.key.slice(-4)}` });
    const after = await published(envId);
    expect(after.keyauth_credentials.map((c) => c.key)).toEqual([k.body.key]);
    expect(after.jwt_secrets?.find((c) => c.id === pendingJwt)?.secret).toBe(j.body.secret);
  });

  it("keeps a matched credential's value and status; a JWT changed from RS256 to HS256 is pending and listed", async () => {
    const { envId, base } = await workspace();
    const k = (await h.api("POST", `${base}/key-auth`, {})).body;
    const iss = uniq("iss");
    const rs = (await h.api("POST", `${base}/jwt`, { key: iss, algorithm: "RS256", rsaPublicKey: rsa() })).body;
    const exported = (await h.api("GET", `/environments/${envId}/export?format=json`)).body;
    // A key supplied for the matched key-auth credential is ignored; the RS256 one becomes HS256.
    exported.consumers[0].keyAuthCredentials[0].key = "an-attempt-to-replace-the-key-0123";
    exported.consumers[0].jwtCredentials[0] = { id: rs.id, key: iss, algorithm: "HS256", secret: `attempt-${"s".repeat(32)}`, tags: [] };
    const res = await h.api("POST", `/environments/${envId}/import`, { document: exported, mode: "merge", dryRun: false });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.pendingCredentials).toEqual([{ path: "document.consumers.0.jwtCredentials.0", credentialType: "jwt", credentialId: rs.id }]);
    const [row] = (await h.sql.query("select key, pending_reprovision from keyauth_credentials where id = $1", [k.id])).rows;
    expect(enc.open(row.key, credentialContext(k.id))).toBe(k.key);
    expect(row.pending_reprovision).toBe(false);
    expect((await h.api("GET", `${base}/jwt`)).body.items).toEqual([expect.objectContaining({ id: rs.id, algorithm: "HS256", status: "pending-reprovision" })]);
  });

  it("serves the credentials created before N1-X6 as they were: active, chosen key and all", async () => {
    const { envId, consumerId, base } = await workspace();
    const id = "00000000-0000-4000-8000-0000000000e1";
    const legacy = "a-key-chosen-before-n1-x6-0123456789";
    await h.sql.query("insert into keyauth_credentials (id, environment_id, consumer_id, key, key_hash) values ($1, $2, $3, $4, $5)", [id, envId, consumerId, enc.seal(legacy, credentialContext(id)), enc.fingerprint(legacy)]);
    expect((await h.api("GET", `${base}/key-auth`)).body.items).toEqual([expect.objectContaining({ id, status: "active", keyHint: `…${legacy.slice(-4)}` })]);
    expect((await published(envId)).keyauth_credentials.map((k) => k.key)).toEqual([legacy]);
    // A round trip through export and import keeps it.
    const exported = (await h.api("GET", `/environments/${envId}/export?format=json`)).body;
    const again = await h.api("POST", `/environments/${envId}/import`, { document: exported, mode: "replace", dryRun: false });
    expect(again.body).toEqual({ added: [], modified: [], removed: [], errors: [], pendingCredentials: [] });
    const [row] = (await h.sql.query("select key, pending_reprovision from keyauth_credentials where id = $1", [id])).rows;
    expect([enc.open(row.key, credentialContext(id)), row.pending_reprovision]).toEqual([legacy, false]);
  });
});
