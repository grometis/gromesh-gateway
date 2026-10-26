import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { Logger } from "@nestjs/common";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { contractsV2 } from "../../src/common/contract.js";
import { AtRestService } from "../../src/crypto/at-rest.js";
import { ENCRYPTOR, type Encryptor, instanceSigningKeyContext } from "../../src/crypto/crypto.js";
import { DB, type Db } from "../../src/db/db.js";
import { runMigrations } from "../../src/db/migrate.js";
import { InstanceSigner, type Jws, NoSigningKeyError, thumbprint } from "../../src/instance/signing-keys.js";
import { type ApiClient, ENCRYPTION_KEYS, startHarness, uniq, type Harness } from "./harness.js";

// N4-D3: the instance's own signing keys and the signer the isolation admissions use. A database of its own: the
// number of active keys is instance-wide, and no other file may create or revoke one under these tests.
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://gromesh:gromesh@127.0.0.1:5432/gromesh";
const name = `gromesh_signing_${Date.now()}_${process.pid}`;
const vector = JSON.parse(readFileSync(new URL("../../../../contracts/examples/isolation-signatures.example.json", import.meta.url), "utf8"));

type Key = { kid: string; publicKey: string; status: string; validFrom: string; validUntil: string; retiredAt: string | null; revokedAt: string | null; createdAt: string };
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const text = (b64: string) => Buffer.from(b64, "base64url").toString("utf8");

/** The reference reading of the contract's Signatures (as the N4-D3 contract test): exact header, own trust, bytes first. */
function accepts(jws: Jws, typ: string, trust: { kid: string; publicKey: string }[]): boolean {
  const json = text(jws.protected);
  const seen = [...json.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map((m) => m[1]);
  const header = JSON.parse(json) as Record<string, unknown>;
  if (new Set(seen).size !== seen.length || seen.length !== 3 || !["alg", "kid", "typ"].every((n) => typeof header[n] === "string")) return false;
  if (header.alg !== "EdDSA" || header.typ !== typ) return false;
  const x = trust.find((k) => k.kid === header.kid)?.publicKey;
  if (!x) return false;
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
  return verify(null, Buffer.from(`${jws.protected}.${jws.payload}`, "ascii"), key, Buffer.from(jws.signature, "base64url"));
}

describe("instance signing keys (N4-D3)", () => {
  let h: Harness;
  let replica: Harness;
  let db: Db;
  let enc: Encryptor;
  let signer: InstanceSigner;
  let dbUrl: string;
  const logged: string[] = [];
  const v2 = (client: ApiClient, method: string, path: string, body?: unknown, headers?: Record<string, string>) => client(method, `/../v2${path}`, body, headers);
  const create = async (client: ApiClient = h.api, validUntil = days(30)) => v2(client, "POST", "/instance/signing-keys", { validUntil });
  const keys = async () => (await v2(h.api, "GET", "/instance/signing-keys")).body.items as Key[];
  const justification = "rotation drill of the test suite";
  /** Revokes every key still usable: each test starts with none. */
  const reset = async () => {
    for (const k of await keys()) if (k.status !== "revoked") expect((await v2(h.api, "POST", `/instance/signing-keys/${k.kid}/revoke`, { justification })).status).toBe(200);
  };
  /** The seed of a key in every encoding it could leak in. */
  const forms = async (kid: string) => {
    const { rows } = await h.sql.query("select private_key from instance_signing_keys where kid = $1", [kid]);
    const sealed = rows[0].private_key as string;
    const seed = Buffer.from(enc.open(sealed, instanceSigningKeyContext(kid)), "base64url");
    expect(seed.length).toBe(32);
    return { sealed, forms: [seed.toString("base64url"), seed.toString("base64"), seed.toString("base64").replace(/=+$/, ""), seed.toString("hex"), seed.toString("hex").toUpperCase()] };
  };
  const leaks = (haystack: string, needles: string[]) => needles.filter((n) => haystack.includes(n));

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    await admin.end();
    const url = new URL(ADMIN_URL);
    url.pathname = `/${name}`;
    dbUrl = url.toString();
    await runMigrations(dbUrl);
    for (const level of ["log", "warn", "error", "debug", "verbose", "fatal"] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void logged.push(JSON.stringify(args)));
    }
    h = await startHarness({ databaseUrl: dbUrl });
    replica = await startHarness({ databaseUrl: dbUrl });
    db = h.app.get<Db>(DB);
    enc = h.app.get<Encryptor>(ENCRYPTOR);
    signer = h.app.get(InstanceSigner);
  }, 120_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    await replica?.close();
    await h?.close();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }, 60_000);
  beforeEach(async () => {
    await reset();
  });

  it("creates a key whose kid is the RFC 7638 thumbprint, sealed for its row, and shows only public data", async () => {
    const validUntil = days(90);
    const res = await create(h.api, validUntil);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const key = res.body as Key;
    const validate = contractsV2.validator("InstanceSigningKey");
    expect(validate(structuredClone(key)), JSON.stringify(validate.errors)).toBe(true);
    expect(key).toMatchObject({ status: "active", retiredAt: null, revokedAt: null, validUntil });
    expect(key.kid).toBe(thumbprint(key.publicKey));
    expect(Buffer.from(key.publicKey, "base64url").length).toBe(32);
    // The sealed seed opens only in its own row: another kid, column or table refuses it.
    const { sealed, forms: seed } = await forms(key.kid);
    expect(sealed.startsWith(`enc:v2:k1:`)).toBe(true);
    const other = (await create()).body as Key;
    for (const ctx of [instanceSigningKeyContext(other.kid), { ...instanceSigningKeyContext(key.kid), column: "public_key" }, { table: "certificates", column: "key", id: key.kid }]) {
      expect(() => enc.open(sealed, ctx)).toThrow(/does not belong to this row/);
    }
    // The seed and the public key make the same pair (what the signer opens is that key).
    const pub = createPublicKey(createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: key.publicKey, d: seed[0]! }, format: "jwk" })).export({ format: "jwk" });
    expect(pub.x).toBe(key.publicKey);
    // Nowhere in a response, the listing, the audit or the stored row's clear columns.
    const listed = await v2(h.api, "GET", "/instance/signing-keys");
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((k: Key) => k.kid)).toEqual([other.kid, key.kid]);
    for (const item of listed.body.items) expect(validate(structuredClone(item)), JSON.stringify(validate.errors)).toBe(true);
    const audited = (await h.sql.query("select action, entity_id, before, after from audit_events where entity_type = 'instance-signing-key'")).rows;
    expect(audited.filter((a) => a.entity_id === key.kid).map((a) => a.action)).toEqual(["instance.signing-key.create"]);
    expect(audited.find((a) => a.entity_id === key.kid).after).toEqual({ kid: key.kid, status: "active", validFrom: key.validFrom, validUntil });
    const clear = (await h.sql.query("select kid, public_key, valid_from, valid_until from instance_signing_keys")).rows;
    for (const where of [JSON.stringify(res.body), JSON.stringify(listed.body), JSON.stringify(audited), JSON.stringify(clear), logged.join("\n")]) {
      expect(leaks(where, [...seed, sealed])).toEqual([]);
    }
    // Control: the search finds the seed where it is (the opened row), so an empty result above means something.
    expect(leaks(JSON.stringify({ d: seed[0] }), seed).length).toBeGreaterThan(0);
  });

  it("validates the request against the contract and the validity window", async () => {
    for (const body of [{}, { validUntil: "tomorrow" }, { validUntil: days(30), privateKey: "x" }]) {
      expect((await v2(h.api, "POST", "/instance/signing-keys", body)).status, JSON.stringify(body)).toBe(422);
    }
    for (const validUntil of [days(0.5), days(1 - 1 / 1440), days(731), new Date(Date.now() - 1000).toISOString()]) {
      const res = await create(h.api, validUntil);
      expect(res.status, validUntil).toBe(422);
      expect(res.body.errors.map((e: { path: string }) => e.path)).toEqual(["validUntil"]);
    }
    expect((await create(h.api, days(729))).status).toBe(201);
    expect((await create(h.api, days(1.01))).status).toBe(201);
    expect((await keys()).filter((k) => k.status === "active")).toHaveLength(2);
  });

  it("keeps at most two keys active, also when replicas create at once", { timeout: 90_000 }, async () => {
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(201);
    const third = await create();
    expect(third.status).toBe(409);
    await reset();
    // Ten creations at once through two replicas: exactly two get in.
    const clients = [h.api, replica.api];
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => create(i % 2 ? clients[1] : clients[0])));
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 409, 409, 409, 409, 409, 409, 409, 409]);
    const { rows } = await h.sql.query("select count(*)::int as n from instance_signing_keys where retired_at is null and revoked_at is null");
    expect(rows[0].n).toBe(2);
    // A retired key frees its place; a revoked one too.
    const [a] = (await keys()).filter((k) => k.status === "active");
    expect((await v2(h.api, "POST", `/instance/signing-keys/${a!.kid}/retire`, { justification })).status).toBe(200);
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(409);
  });

  it("is for the platform admin only, and its mutations for a session with CSRF only", { timeout: 90_000 }, async () => {
    const key = (await create()).body as Key;
    const editor = await h.as("editor");
    const workspaceAdmin = await h.as("viewer");
    const env = (await h.api("POST", "/environments", { name: uniq("keys") })).body.id as string;
    expect((await v2(h.api, "POST", `/workspaces/${env}/role-bindings`, { subjectType: "user", subjectId: workspaceAdmin.id, role: "workspace-admin" })).status).toBe(201);
    const envAdmin = await h.as("viewer");
    expect((await h.api("PUT", `/users/${envAdmin.id}/environment-roles`, { items: [{ environmentId: env, role: "admin" }] })).status).toBe(200);
    const platform = await h.as("viewer");
    expect((await v2(h.api, "POST", "/role-bindings", { subjectType: "user", subjectId: platform.id, role: "platform-admin" })).status).toBe(201);
    const token = (await h.api("POST", "/users/me/tokens", { name: uniq("keys"), role: "admin", expiresInDays: 1 })).body.token as string;
    const bearer: ApiClient = (method, path, body) => h.anonymous(method, path, body, { authorization: `Bearer ${token}` });
    const noCsrf: ApiClient = async (method, path, body) => {
      const session = await h.login(platform.email, platform.password);
      return h.anonymous(method, path, body, { cookie: session.cookie! });
    };
    const ops: [string, string, unknown][] = [
      ["POST", "/instance/signing-keys", { validUntil: days(30) }],
      ["POST", `/instance/signing-keys/${key.kid}/retire`, { justification }],
      ["POST", `/instance/signing-keys/${key.kid}/revoke`, { justification }],
    ];
    for (const [who, client] of [["editor", editor.api], ["workspace admin", workspaceAdmin.api], ["environment admin", envAdmin.api]] as const) {
      expect((await v2(client, "GET", "/instance/signing-keys")).status, who).toBe(403);
      for (const [method, path, body] of ops) expect((await v2(client, method, path, body)).status, `${who} ${path}`).toBe(403);
    }
    for (const [method, path, body] of ops) {
      expect((await v2(h.anonymous, method, path, body)).status, `anonymous ${path}`).toBe(401);
      expect((await v2(bearer, method, path, body)).status, `token ${path}`).toBe(401);
      expect((await v2(noCsrf, method, path, body)).status, `no CSRF ${path}`).toBe(403);
    }
    // A token of the platform admin reads (GET accepts a bearer); the platform admin by binding manages.
    expect((await v2(bearer, "GET", "/instance/signing-keys")).status).toBe(200);
    expect((await v2(platform.api, "GET", "/instance/signing-keys")).status).toBe(200);
    expect((await create(platform.api)).status).toBe(201);
    expect((await v2(platform.api, "POST", `/instance/signing-keys/${key.kid}/retire`, { justification })).status).toBe(200);
    // Nothing the refused calls tried happened.
    const { rows } = await h.sql.query("select action from audit_events where entity_type = 'instance-signing-key' and entity_id = $1 order by at", [key.kid]);
    expect(rows.map((r) => r.action)).toEqual(["instance.signing-key.create", "instance.signing-key.retire"]);
  });

  it("retires only an active key with another active key covering now, and revokes always, once", async () => {
    const first = (await create()).body as Key;
    const retire = (kid: string, body: unknown = { justification }) => v2(h.api, "POST", `/instance/signing-keys/${kid}/retire`, body);
    const revoke = (kid: string, body: unknown = { justification }) => v2(h.api, "POST", `/instance/signing-keys/${kid}/revoke`, body);
    expect((await retire(first.kid)).status).toBe(409);
    const second = (await create()).body as Key;
    // Another active key that does not cover now (expired) does not count.
    await h.sql.query("update instance_signing_keys set valid_until = now() - interval '1 second', valid_from = now() - interval '2 days' where kid = $1", [second.kid]);
    expect((await retire(first.kid)).status).toBe(409);
    await h.sql.query("update instance_signing_keys set valid_until = now() + interval '10 days' where kid = $1", [second.kid]);
    expect((await retire(first.kid, { justification: "short" })).status).toBe(422);
    expect((await retire(first.kid, { justification, extra: true })).status).toBe(422);
    const retired = await retire(first.kid);
    expect(retired.status).toBe(200);
    expect(retired.body).toMatchObject({ kid: first.kid, status: "retired", revokedAt: null });
    expect(retired.body.retiredAt).not.toBeNull();
    expect((await retire(first.kid)).status).toBe(409);
    expect((await retire(second.kid)).status).toBe(409);
    // Revoke: the last active key too, a retired key too, never twice.
    const revoked = await revoke(second.kid);
    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({ key: expect.objectContaining({ kid: second.kid, status: "revoked" }), openAdmissions: 0 });
    expect((await revoke(first.kid)).body.key).toMatchObject({ status: "revoked", retiredAt: retired.body.retiredAt });
    expect((await revoke(first.kid)).status).toBe(409);
    expect((await retire(second.kid)).status).toBe(409);
    expect((await revoke("A".repeat(43))).status).toBe(404);
    expect((await revoke("not-a-kid")).status).toBe(404);
    expect((await retire("A".repeat(43))).status).toBe(404);
    const audited = (await h.sql.query("select action, after from audit_events where entity_type = 'instance-signing-key' and entity_id = $1 order by at", [first.kid])).rows;
    expect(audited.map((a) => a.action)).toEqual(["instance.signing-key.create", "instance.signing-key.retire", "instance.signing-key.revoke"]);
    expect(audited[1].after).toMatchObject({ kid: first.kid, status: "retired", justification });
    expect(audited[2].after).toMatchObject({ kid: first.kid, status: "revoked", justification, openAdmissions: 0 });
    // The revocation alert names the key and never its material.
    expect(logged.some((l) => l.includes(`Instance signing key ${second.kid} revoked`))).toBe(true);
  });

  it("signs with the active key of the latest validFrom covering now, accepted by the reference verifier", async () => {
    await expect(db.transaction((tx) => signer.sign(tx, "gromesh-admission+json", vector.admissionClaims))).rejects.toBeInstanceOf(NoSigningKeyError);
    const a = (await create()).body as Key;
    const b = (await create()).body as Key;
    const trust = (await keys()).map(({ kid, publicKey }) => ({ kid, publicKey }));
    const signed = await db.transaction((tx) => signer.sign(tx, "gromesh-admission+json", vector.admissionClaims));
    expect(signed.kid).toBe(b.kid);
    expect(text(signed.jws.protected)).toBe(`{"alg":"EdDSA","kid":"${b.kid}","typ":"gromesh-admission+json"}`);
    expect(text(signed.jws.payload)).toBe(JSON.stringify(vector.admissionClaims));
    expect(accepts(signed.jws, "gromesh-admission+json", trust)).toBe(true);
    // Negative controls of the same verifier: another typ, a key outside the trust, a changed payload.
    expect(accepts(signed.jws, "gromesh-isolation-release+json", trust)).toBe(false);
    expect(accepts(signed.jws, "gromesh-admission+json", trust.filter((k) => k.kid !== b.kid))).toBe(false);
    expect(accepts({ ...signed.jws, payload: Buffer.from(JSON.stringify({ ...vector.admissionClaims, nodeName: "x" })).toString("base64url") }, "gromesh-admission+json", trust)).toBe(false);
    const release = await db.transaction((tx) => signer.sign(tx, "gromesh-isolation-release+json", vector.releaseClaims));
    expect(accepts(release.jws, "gromesh-isolation-release+json", trust)).toBe(true);
    // A key that does not cover now is skipped (validFrom in the future, then expired), a retired one too.
    await h.sql.query("update instance_signing_keys set valid_from = now() + interval '1 hour' where kid = $1", [b.kid]);
    expect((await db.transaction((tx) => signer.sign(tx, "gromesh-admission+json", {}))).kid).toBe(a.kid);
    await h.sql.query("update instance_signing_keys set valid_from = now() - interval '2 days', valid_until = now() - interval '1 second' where kid = $1", [b.kid]);
    expect((await db.transaction((tx) => signer.sign(tx, "gromesh-admission+json", {}))).kid).toBe(a.kid);
    await h.sql.query("update instance_signing_keys set valid_until = now() + interval '5 days' where kid = $1", [b.kid]);
    expect((await v2(h.api, "POST", `/instance/signing-keys/${b.kid}/retire`, { justification })).status).toBe(200);
    expect((await db.transaction((tx) => signer.sign(tx, "gromesh-admission+json", {}))).kid).toBe(a.kid);
    // After the revocation nothing signs with it.
    expect((await v2(h.api, "POST", `/instance/signing-keys/${a.kid}/revoke`, { justification })).status).toBe(200);
    await expect(db.transaction((tx) => signer.sign(tx, "gromesh-admission+json", {}))).rejects.toBeInstanceOf(NoSigningKeyError);
  });

  it("produces the contract vector byte for byte with its test-only instance key", async () => {
    const d = Buffer.from(vector.testOnlySeedsHex.instance, "hex").toString("base64url");
    const [{ kid, publicKey }] = vector.trustSet.keys;
    expect(createPublicKey(createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey, d }, format: "jwk" })).export({ format: "jwk" }).x).toBe(publicKey);
    await h.sql.query("insert into instance_signing_keys (kid, public_key, private_key, valid_from, valid_until) values ($1, $2, $3, now() - interval '1 minute', now() + interval '1 day')", [kid, publicKey, enc.seal(d, instanceSigningKeyContext(kid))]);
    const admission = await db.transaction((tx) => signer.sign(tx, "gromesh-admission+json", vector.admissionClaims));
    expect(admission).toEqual({ jws: vector.admission, kid });
    const release = await db.transaction((tx) => signer.sign(tx, "gromesh-isolation-release+json", vector.releaseClaims));
    expect(release).toEqual({ jws: vector.release, kid });
    // A row sealed for another kid does not open as this one: the signer fails instead of signing.
    await h.sql.query("update instance_signing_keys set private_key = $2 where kid = $1", [kid, enc.seal(d, instanceSigningKeyContext("B".repeat(43)))]);
    await expect(db.transaction((tx) => signer.sign(tx, "gromesh-admission+json", vector.admissionClaims))).rejects.toThrow(/does not belong to this row/);
    // The tampered row would also stop a rotation (it cannot be re-sealed): it goes.
    await h.sql.query("delete from instance_signing_keys where kid = $1", [kid]);
  });

  it("never signs after a concurrent revocation commits, and the revocation waits for a signature in flight", async () => {
    const key = (await create()).body as Key;
    // A revocation committed while a signature waits on the row: the signature finds no key.
    const revoking = new pg.Client({ connectionString: dbUrl });
    await revoking.connect();
    try {
      await revoking.query("begin");
      await revoking.query("select 1 from instance_signing_keys where kid = $1 for update", [key.kid]);
      await revoking.query("update instance_signing_keys set revoked_at = now() where kid = $1", [key.kid]);
      let settled = false;
      const signing = db.transaction((tx) => signer.sign(tx, "gromesh-admission+json", {})).finally(() => (settled = true));
      signing.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      await revoking.query("commit");
      await expect(signing).rejects.toBeInstanceOf(NoSigningKeyError);
    } finally {
      await revoking.end();
    }
    // A signature in flight holds the key until its commit: the revocation through the API waits for it.
    const next = (await create()).body as Key;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let signedKid = "";
    const inFlight = db.transaction(async (tx) => {
      signedKid = (await signer.sign(tx, "gromesh-admission+json", {})).kid;
      await held;
    });
    await new Promise((r) => setTimeout(r, 100));
    let revokedAt = 0;
    const revocation = v2(replica.api, "POST", `/instance/signing-keys/${next.kid}/revoke`, { justification }).then((r) => ((revokedAt = Date.now()), r));
    await new Promise((r) => setTimeout(r, 300));
    expect(revokedAt).toBe(0);
    const committedAt = Date.now();
    release();
    await inFlight;
    expect((await revocation).status).toBe(200);
    expect(signedKid).toBe(next.kid);
    expect(revokedAt).toBeGreaterThanOrEqual(committedAt);
    await expect(db.transaction((tx) => signer.sign(tx, "gromesh-admission+json", {}))).rejects.toBeInstanceOf(NoSigningKeyError);
  });

  it("re-seals the keys on an encryption key rotation, so dropping the old key loses none", { timeout: 90_000 }, async () => {
    const key = (await create()).body as Key;
    const { forms: before } = await forms(key.kid);
    const rotated = await startHarness({ databaseUrl: dbUrl, encryption: { writeKey: ENCRYPTION_KEYS.k2, readKeys: [ENCRYPTION_KEYS.k1], fingerprintKey: ENCRYPTION_KEYS.fingerprint } });
    try {
      const report = await rotated.app.get(AtRestService).rotate();
      expect(report.signingKeys).toBeGreaterThanOrEqual(1);
      const { rows } = await h.sql.query("select private_key from instance_signing_keys where kid = $1", [key.kid]);
      expect((rows[0].private_key as string).startsWith("enc:v2:k2:")).toBe(true);
      const after = Buffer.from(rotated.app.get<Encryptor>(ENCRYPTOR).open(rows[0].private_key, instanceSigningKeyContext(key.kid)), "base64url").toString("base64url");
      expect(after).toBe(before[0]);
      const signed = await rotated.app.get<Db>(DB).transaction((tx) => rotated.app.get(InstanceSigner).sign(tx, "gromesh-admission+json", {}));
      expect(accepts(signed.jws, "gromesh-admission+json", [key])).toBe(true);
    } finally {
      await rotated.close();
    }
  });
});
