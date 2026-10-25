import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENCRYPTOR, type Encryptor } from "../../src/crypto/crypto.js";
import { runMigrations } from "../../src/db/migrate.js";
import * as schema from "../../src/db/schema.js";
import { enforceInstanceUniqueness } from "../../src/workspaces/instance-uniqueness.js";
import { migrationReport } from "../../src/workspaces/migration-report.js";
import { selfSigned } from "./certs.js";
import { startHarness, uniq, type Harness } from "./harness.js";

// N1-X3: consumer names are unique in the workspace (decision H-5); what Kong looks up across the node — key-auth key,
// JWT key, basic-auth username, SNI — is unique in the instance, with a generic conflict that never names the other
// workspace, audited and limited.
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://gromesh:gromesh@127.0.0.1:5432/gromesh";

describe("uniqueness in the workspace and in the instance", () => {
  let h: Harness;
  const env = async () => (await h.api("POST", "/environments", { name: uniq("uq") })).body.id as string;
  const consumer = async (envId: string, username = "app-sky") => (await h.api("POST", `/environments/${envId}/consumers`, { username })).body.id as string;

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  it("accepts the same consumer name in two workspaces, as independent consumers, and refuses it twice in one", async () => {
    const [a, b] = [await env(), await env()];
    const ca = await h.api("POST", `/environments/${a}/consumers`, { username: "app-sky", customId: "sky" });
    const cb = await h.api("POST", `/environments/${b}/consumers`, { username: "app-sky", customId: "sky" });
    expect([ca.status, cb.status]).toEqual([201, 201]);
    expect(ca.body.id).not.toBe(cb.body.id);
    expect((await h.api("POST", `/environments/${a}/consumers`, { username: "app-sky" })).status).toBe(409);
  });

  it("refuses a credential or server name another workspace holds with the same generic 409, audited without the value", async () => {
    const [a, b] = [await env(), await env()];
    const [ca, cb] = [await consumer(a), await consumer(b)];
    const key = uniq("key-auth-value-0123456789");
    const iss = uniq("issuer");
    const user = uniq("login");
    const name = `${uniq("site")}.example.test`;
    const cert = selfSigned(name);
    const writes = (envId: string, consumerId: string) => [
      ["key-auth-key", () => h.api("POST", `/environments/${envId}/consumers/${consumerId}/key-auth`, { key })],
      ["jwt-key", () => h.api("POST", `/environments/${envId}/consumers/${consumerId}/jwt`, { key: iss })],
      ["basic-auth-username", () => h.api("POST", `/environments/${envId}/consumers/${consumerId}/basic-auth`, { username: user, password: "a-long-password" })],
      ["sni", () => h.api("POST", `/environments/${envId}/certificates`, { cert: cert.cert, key: cert.key, snis: [name] })],
    ] as const;
    for (const [kind, write] of writes(a, ca)) expect((await write()).status, kind).toBe(201);
    for (const [kind, write] of writes(b, cb)) {
      const res = await write();
      expect(res.status, kind).toBe(409);
      expect(res.body, kind).toEqual({ type: "https://gromesh.dev/problems/409", title: "Conflict", status: 409, detail: "Already in use in this instance" });
      expect(JSON.stringify(res.body), kind).not.toContain(a);
    }
    const events = (await h.sql.query(`select entity_type, after from audit_events where action = 'uniqueness.conflict' and at > now() - interval '1 minute' order by at`)).rows;
    expect(events.map((e) => e.entity_type)).toEqual(expect.arrayContaining(["key-auth-key", "jwt-key", "basic-auth-username", "sni"]));
    for (const e of events) for (const secret of [key, iss, user, name]) expect(JSON.stringify(e)).not.toContain(secret);
    // Nothing was written in b.
    for (const table of ["keyauth_credentials", "jwt_credentials", "basicauth_credentials", "certificates"]) {
      expect((await h.sql.query(`select count(*)::int as n from ${table} where environment_id = $1`, [b])).rows[0].n, table).toBe(0);
    }
  });

  it("limits conflicting writes: past the limit the actor gets 429 with Retry-After", async () => {
    const [a, b] = [await env(), await env()];
    const [ca, cb] = [await consumer(a), await consumer(b)];
    const iss = uniq("probe");
    expect((await h.api("POST", `/environments/${a}/consumers/${ca}/jwt`, { key: iss })).status).toBe(201);
    // A replica with a low limit (the others raise it: every test acts as the same admin).
    const low = await startHarness({ uniqueConflictMax: 3 });
    try {
      const prober = await low.as("editor");
      for (let i = 0; i < 3; i++) expect((await prober.api("POST", `/environments/${b}/consumers/${cb}/jwt`, { key: iss })).status).toBe(409);
      const limited = await prober.api("POST", `/environments/${b}/consumers/${cb}/jwt`, { key: uniq("free") });
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      // Someone else is not affected.
      expect((await low.api("POST", `/environments/${b}/consumers/${cb}/jwt`, { key: uniq("free") })).status).toBe(201);
    } finally {
      await low.close();
    }
  });

  it("lets exactly one of two concurrent writers take a value", async () => {
    const [a, b] = [await env(), await env()];
    const [ca, cb] = [await consumer(a), await consumer(b)];
    const user = uniq("race");
    const results = await Promise.all([
      h.api("POST", `/environments/${a}/consumers/${ca}/basic-auth`, { username: user, password: "a-long-password" }),
      h.api("POST", `/environments/${b}/consumers/${cb}/basic-auth`, { username: user, password: "a-long-password" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it("reports a value another workspace holds as an import error at its path, in a dry run and for real", async () => {
    const [a, b] = [await env(), await env()];
    const ca = await consumer(a);
    const iss = uniq("imported");
    expect((await h.api("POST", `/environments/${a}/consumers/${ca}/jwt`, { key: iss })).status).toBe(201);
    const document = { apiVersion: "gromesh/v1", services: [], routes: [], consumers: [{ username: "app-sky", tags: [], aclGroups: [], keyAuthCredentials: [], jwtCredentials: [{ key: iss, algorithm: "HS256", secret: "s".repeat(40), tags: [] }], basicAuthCredentials: [] }], plugins: [], upstreams: [], certificates: [] };
    const error = { path: "document.consumers.0.jwtCredentials.0.key", message: "already in use in this instance" };
    const dry = await h.api("POST", `/environments/${b}/import`, { mode: "merge", document, dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.errors).toContainEqual(error);
    const real = await h.api("POST", `/environments/${b}/import`, { mode: "merge", document, dryRun: false });
    expect(real.status).toBe(422);
    expect(real.body.errors).toContainEqual(error);
    expect((await h.sql.query(`select count(*)::int as n from consumers where environment_id = $1`, [b])).rows[0].n).toBe(0);
    expect((await h.sql.query(`select count(*)::int as n from audit_events where action = 'uniqueness.conflict' and entity_type = 'import' and at > now() - interval '1 minute'`)).rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it("refuses a rollback to a version holding a value another workspace took since", async () => {
    const [a, b] = [await env(), await env()];
    const [ca, cb] = [await consumer(a), await consumer(b)];
    const iss = uniq("released");
    const e = `/environments/${a}`;
    const jwt = (await h.api("POST", `${e}/consumers/${ca}/jwt`, { key: iss })).body;
    expect((await h.api("POST", `${e}/snapshots`, {})).status).toBe(201);
    expect((await h.api("DELETE", `${e}/consumers/${ca}/jwt/${jwt.id}`)).status).toBe(204);
    expect((await h.api("POST", `${e}/snapshots`, {})).status).toBe(201);
    // Freed in a, taken by b.
    expect((await h.api("POST", `/environments/${b}/consumers/${cb}/jwt`, { key: iss })).status).toBe(201);
    const rolled = await h.api("POST", `${e}/snapshots/1/rollback`);
    expect(rolled.status).toBe(409);
    expect(rolled.body.detail).toBe("Already in use in this instance");
  });

  it("has the instance indexes in force on a clean instance", async () => {
    const rows = (await h.sql.query(`select indexname from pg_indexes where indexname like '%instance_uq' order by indexname`)).rows.map((r) => r.indexname);
    expect(rows).toEqual(["basicauth_username_instance_uq", "certificate_snis_name_instance_uq", "jwt_key_instance_uq", "keyauth_key_hash_instance_uq"]);
  });
});

describe("an instance migrated with credentials repeated across environments", () => {
  let url: string;
  let h: Harness;
  const name = `gromesh_uq_${Date.now()}_${process.pid}`;
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  let pool: pg.Pool;
  const db = () => drizzle(pool, { schema });
  const report = () => db().transaction((tx) => migrationReport(tx, h.app.get<Encryptor>(ENCRYPTOR)));

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    await admin.end();
    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    url = u.toString();
    await runMigrations(url);
    // Legal before N1 (unique per environment only): the same JWT key and basic-auth username in two environments.
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    await c.query(`insert into environments (id, name) values ('${id(1)}', 'one'), ('${id(2)}', 'two')`);
    await c.query(`insert into consumers (id, environment_id, username) values ('${id(10)}', '${id(1)}', 'app-sky'), ('${id(20)}', '${id(2)}', 'app-sky')`);
    // Written in clear, as the oldest versions did: the start seals the secrets (crypto/at-rest).
    const secret = "s".repeat(40), hash = "a".repeat(40);
    await c.query(`insert into jwt_credentials (id, environment_id, consumer_id, key, algorithm, secret) values ('${id(11)}', '${id(1)}', '${id(10)}', 'shared-iss', 'HS256', '${secret}'), ('${id(21)}', '${id(2)}', '${id(20)}', 'shared-iss', 'HS256', '${secret}')`);
    await c.query(`insert into basicauth_credentials (id, environment_id, consumer_id, username, password_hash) values ('${id(12)}', '${id(1)}', '${id(10)}', 'shared-login', '${hash}'), ('${id(22)}', '${id(2)}', '${id(20)}', 'shared-login', '${hash}')`);
    await c.end();
    h = await startHarness({ databaseUrl: url });
    pool = new pg.Pool({ connectionString: url, max: 1 });
  });

  afterAll(async () => {
    await pool?.end();
    await h?.close();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  });

  const indexes = async () => (await h.sql.query(`select indexname from pg_indexes where indexname like '%instance_uq' order by indexname`)).rows.map((r) => r.indexname);

  it("keeps the rows, leaves the blocked kinds without an instance index and reports each blocker by identity only", async () => {
    expect(await indexes()).toEqual(["certificate_snis_name_instance_uq", "keyauth_key_hash_instance_uq"]);
    const r = await report();
    expect(r.status).toBe("blocked");
    expect(r.blockers).toEqual([
      { kind: "basic-auth-username", occurrences: [
        { workspaceId: id(1), source: "draft", entityType: "basic-auth-credential", entityId: id(12), snapshotVersion: null },
        { workspaceId: id(2), source: "draft", entityType: "basic-auth-credential", entityId: id(22), snapshotVersion: null },
      ] },
      { kind: "jwt-key", occurrences: [
        { workspaceId: id(1), source: "draft", entityType: "jwt-credential", entityId: id(11), snapshotVersion: null },
        { workspaceId: id(2), source: "draft", entityType: "jwt-credential", entityId: id(21), snapshotVersion: null },
      ] },
    ]);
    expect(JSON.stringify(r)).not.toMatch(/shared-iss|shared-login/);
    expect(r.workspaces.map((w) => ({ name: w.name, slug: w.slug }))).toEqual([{ name: "one", slug: "one" }, { name: "two", slug: "two" }]);
  });

  it("still refuses a new repetition through the service while the index is not in force", async () => {
    const res = await h.api("POST", `/environments/${id(2)}/consumers/${id(20)}/jwt`, { key: "shared-iss-2" });
    expect(res.status).toBe(201);
    const again = await h.api("POST", `/environments/${id(1)}/consumers/${id(10)}/jwt`, { key: "shared-iss-2" });
    expect(again.status).toBe(409);
  });

  it("counts a published version and a rollback candidate as blockers too, and completes once the last one is gone", async () => {
    // Environment two publishes (its version holds the repeated values), then drops them from its draft.
    for (const path of [`/environments/${id(2)}/snapshots`]) expect((await h.api("POST", path, {})).status).toBe(201);
    await h.sql.query(`delete from jwt_credentials where environment_id = $1`, [id(2)]);
    await h.sql.query(`delete from basicauth_credentials where environment_id = $1`, [id(2)]);
    let r = await report();
    expect(r.status).toBe("blocked");
    expect(r.blockers.flatMap((b) => b.occurrences.map((o) => o.source)).sort()).toEqual(["active-snapshot", "active-snapshot", "draft", "draft"]);
    // The draft no longer repeats anything: the instance indexes are in force.
    expect(await indexes()).toEqual(["basicauth_username_instance_uq", "certificate_snis_name_instance_uq", "jwt_key_instance_uq", "keyauth_key_hash_instance_uq"]);
    // A newer version without them leaves the old one as a rollback candidate, still a blocker.
    await h.sql.query(`update environments set has_unpublished_changes = true where id = $1`, [id(2)]);
    await h.api("POST", `/environments/${id(2)}/consumers`, { username: "trigger-change" });
    expect((await h.api("POST", `/environments/${id(2)}/snapshots`, {})).status).toBe(201);
    r = await report();
    expect(r.blockers.flatMap((b) => b.occurrences.map((o) => o.source)).sort()).toEqual(["draft", "draft", "rollback-candidate", "rollback-candidate"]);
    // Environment one frees the values: complete.
    await h.sql.query(`delete from jwt_credentials where environment_id = $1`, [id(1)]);
    await h.sql.query(`delete from basicauth_credentials where environment_id = $1`, [id(1)]);
    r = await report();
    expect(r).toMatchObject({ status: "complete", blockers: [] });
    expect(await db().transaction((tx) => enforceInstanceUniqueness(tx))).toEqual([]);
  });
});
