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

  it("counts every one of concurrent conflicts (no lost update) and audits a rollback's", async () => {
    const [a, b] = [await env(), await env()];
    const [ca, cb] = [await consumer(a), await consumer(b)];
    const iss = uniq("burst");
    expect((await h.api("POST", `/environments/${a}/consumers/${ca}/jwt`, { key: iss })).status).toBe(201);
    const actor = await h.as("editor");
    const burst = await Promise.all(Array.from({ length: 5 }, () => actor.api("POST", `/environments/${b}/consumers/${cb}/jwt`, { key: iss })));
    expect(burst.map((r) => r.status)).toEqual([409, 409, 409, 409, 409]);
    expect((await h.sql.query(`select failures from login_attempts where key = $1`, [`conflict:${actor.id}`])).rows[0].failures).toBe(5);
    // A rollback that collides is audited too (kind rollback, no value).
    const e = `/environments/${b}`;
    const free = uniq("later");
    const own = (await h.api("POST", `${e}/consumers/${cb}/jwt`, { key: free })).body;
    expect((await h.api("POST", `${e}/snapshots`, {})).status).toBe(201);
    await h.api("DELETE", `${e}/consumers/${cb}/jwt/${own.id}`);
    expect((await h.api("POST", `${e}/snapshots`, {})).status).toBe(201);
    expect((await h.api("POST", `/environments/${a}/consumers/${ca}/jwt`, { key: free })).status).toBe(201);
    expect((await actor.api("POST", `${e}/snapshots/1/rollback`)).status).toBe(409);
    const audited = (await h.sql.query(`select after from audit_events where action = 'uniqueness.conflict' and entity_type = 'rollback' and actor->>'id' = $1`, [actor.id])).rows;
    expect(audited).toEqual([{ after: { kind: "rollback" } }]);
  });

  it("counts an import conflict even when the redaction rewrites its message", async () => {
    const [a, b] = [await env(), await env()];
    const ca = await consumer(a);
    const iss = uniq("redacted");
    expect((await h.api("POST", `/environments/${a}/consumers/${ca}/jwt`, { key: iss })).status).toBe(201);
    const actor = await h.as("editor");
    // A password equal to a word of the message: the redaction replaces it in the diagnostics.
    const document = { apiVersion: "gromesh/v1", services: [], routes: [], consumers: [{ username: "app-sky", tags: [], aclGroups: [], keyAuthCredentials: [], jwtCredentials: [{ key: iss, algorithm: "HS256", secret: "s".repeat(40), tags: [] }], basicAuthCredentials: [{ username: uniq("u"), password: "instance", tags: [] }] }], plugins: [], upstreams: [], certificates: [] };
    const dry = await actor.api("POST", `/environments/${b}/import`, { mode: "merge", document, dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.errors.length).toBeGreaterThan(0);
    expect((await h.sql.query(`select count(*)::int as n from audit_events where action = 'uniqueness.conflict' and entity_type = 'import' and actor->>'id' = $1`, [actor.id])).rows[0].n).toBe(1);
  });

  it("takes the environment's row before the uniqueness lock, as rollback and import do (no lock-order deadlock)", async () => {
    const a = await env();
    const ca = await consumer(a);
    const holder = await h.sql.connect();
    try {
      await holder.query("begin");
      await holder.query(`select id from environments where id = $1 for update`, [a]);
      const creating = h.api("POST", `/environments/${a}/consumers/${ca}/jwt`, { key: uniq("ordered") });
      // The backend of the creation, blocked on the row the holder keeps.
      let waiter: number | undefined;
      for (let i = 0; i < 200 && waiter === undefined; i++) {
        await new Promise((r) => setTimeout(r, 25));
        waiter = (await h.sql.query(`select pid from pg_stat_activity where wait_event_type = 'Lock' and $1 = any(pg_blocking_pids(pid))`, [(await holder.query("select pg_backend_pid() as pid")).rows[0].pid])).rows[0]?.pid;
      }
      expect(waiter).toBeDefined();
      // While it waits for the row, it holds no uniqueness lock a rollback of this workspace would then wait for.
      const held = (await h.sql.query(`select count(*)::int as n from pg_locks where pid = $1 and locktype = 'advisory' and classid = $2 and granted`, [waiter, 0x6772_7563])).rows[0].n;
      expect(held).toBe(0);
      await holder.query("commit");
      expect((await creating).status).toBe(201);
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
  });

  it("stops probing at the limit even under a burst: of six concurrent conflicts, three answer 409 and three 429", async () => {
    const [a, b] = [await env(), await env()];
    const [ca, cb] = [await consumer(a), await consumer(b)];
    const iss = uniq("limited-burst");
    expect((await h.api("POST", `/environments/${a}/consumers/${ca}/jwt`, { key: iss })).status).toBe(201);
    const low = await startHarness({ uniqueConflictMax: 3 });
    try {
      const prober = await low.as("editor");
      const burst = await Promise.all(Array.from({ length: 6 }, () => prober.api("POST", `/environments/${b}/consumers/${cb}/jwt`, { key: iss })));
      expect(burst.map((r) => r.status).sort()).toEqual([409, 409, 409, 429, 429, 429]);
    } finally {
      await low.close();
    }
  });

  it("stops a burst of probing imports at the limit too: one at a time, each sees the previous count", async () => {
    const [a, b] = [await env(), await env()];
    const ca = await consumer(a);
    const iss = uniq("import-burst");
    expect((await h.api("POST", `/environments/${a}/consumers/${ca}/jwt`, { key: iss })).status).toBe(201);
    const document = { apiVersion: "gromesh/v1", services: [], routes: [], consumers: [{ username: "app-sky", tags: [], aclGroups: [], keyAuthCredentials: [], jwtCredentials: [{ key: iss, algorithm: "HS256", secret: "s".repeat(40), tags: [] }], basicAuthCredentials: [] }], plugins: [], upstreams: [], certificates: [] };
    const low = await startHarness({ uniqueConflictMax: 3 });
    try {
      const prober = await low.as("editor");
      // Each into an environment of its own: nothing but the queue orders them.
      const targets = [b, ...(await Promise.all(Array.from({ length: 5 }, () => env())))];
      const burst = await Promise.all(targets.map((t) => prober.api("POST", `/environments/${t}/import`, { mode: "merge", document, dryRun: true })));
      expect(burst.map((r) => r.status).sort()).toEqual([200, 200, 200, 429, 429, 429]);
    } finally {
      await low.close();
    }
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
  const report = () => migrationReport(db(), h.app.get<Encryptor>(ENCRYPTOR));

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

  it("reports a repeated credential kept from the draft by a merge, in the dry run and as the 422", async () => {
    const document = { apiVersion: "gromesh/v1", services: [{ name: "only-a-service", protocol: "http", host: "a.example.com", port: 80, tags: [] }], routes: [], consumers: [], plugins: [], upstreams: [], certificates: [] };
    const dry = await h.api("POST", `/environments/${id(1)}/import`, { mode: "merge", document, dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.errors).toContainEqual({ path: "document", message: "an entity kept from the draft holds a value already in use in this instance" });
    const real = await h.api("POST", `/environments/${id(1)}/import`, { mode: "merge", document, dryRun: false });
    expect(real.status).toBe(422);
    expect(real.body.errors).toContainEqual({ path: "document", message: "an entity kept from the draft holds a value already in use in this instance" });
  });

  it("sees a value another workspace commits while the import waits, though its snapshot is serializable", async () => {
    const writer = new pg.Client({ connectionString: url });
    await writer.connect();
    try {
      // Another workspace writes a key and has not committed yet (the JWT index is not in force: keys repeat).
      await writer.query("begin");
      await writer.query(`insert into jwt_credentials (environment_id, consumer_id, key, algorithm, secret) values ($1, $2, 'raced-iss', 'HS256', $3)`, [id(2), id(20), "s".repeat(40)]);
      const document = { apiVersion: "gromesh/v1", services: [], routes: [], consumers: [{ username: "app-sky", tags: [], aclGroups: [], keyAuthCredentials: [], jwtCredentials: [{ key: "raced-iss", algorithm: "HS256", secret: "s".repeat(40), tags: [] }], basicAuthCredentials: [] }], plugins: [], upstreams: [], certificates: [] };
      const importing = h.api("POST", `/environments/${id(1)}/import`, { mode: "merge", document, dryRun: false });
      const writerPid = (await writer.query("select pg_backend_pid() as pid")).rows[0].pid;
      let blocked = false;
      for (let i = 0; i < 200 && !blocked; i++) {
        await new Promise((r) => setTimeout(r, 25));
        blocked = (await h.sql.query(`select count(*)::int as n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))`, [writerPid])).rows[0].n > 0;
      }
      expect(blocked).toBe(true);
      await writer.query("commit");
      const res = await importing;
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.errors).toContainEqual({ path: "document.consumers.0.jwtCredentials.0.key", message: "already in use in this instance" });
    } finally {
      await writer.query("rollback").catch(() => undefined);
      await writer.query(`delete from jwt_credentials where key = 'raced-iss'`);
      await writer.end();
    }
  });

  it("never lets a writer hold the environment's row while it waits for the table an import locked (no cycle)", async () => {
    const importer = new pg.Client({ connectionString: url });
    await importer.connect();
    try {
      // What an import does while the JWT index is not in force: the table first, then the environment's row.
      await importer.query("begin");
      await importer.query("lock table jwt_credentials in share row exclusive mode");
      const creating = h.api("POST", `/environments/${id(1)}/consumers/${id(10)}/jwt`, { key: "ordered-iss" });
      const importerPid = (await importer.query("select pg_backend_pid() as pid")).rows[0].pid;
      let waiter: number | undefined;
      for (let i = 0; i < 200 && waiter === undefined; i++) {
        await new Promise((r) => setTimeout(r, 25));
        waiter = (await h.sql.query(`select pid from pg_stat_activity where $1 = any(pg_blocking_pids(pid))`, [importerPid])).rows[0]?.pid;
      }
      expect(waiter).toBeDefined();
      // The writer waits at its first statement: it holds no lock on environments, so the import takes the row.
      const onEnvironments = (await h.sql.query(`select count(*)::int as n from pg_locks l join pg_class c on c.oid = l.relation where l.pid = $1 and c.relname = 'environments' and l.granted`, [waiter])).rows[0].n;
      expect(onEnvironments).toBe(0);
      await importer.query(`select id from environments where id = $1 for update`, [id(1)]);
      await importer.query("commit");
      expect((await creating).status).toBe(201);
    } finally {
      await importer.query("rollback").catch(() => undefined);
      await importer.query(`delete from jwt_credentials where key = 'ordered-iss'`);
      await importer.end();
    }
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

describe("an instance whose key-auth fingerprints were not all filled in (an interrupted 0005)", () => {
  const name = `gromesh_fp_${Date.now()}_${process.pid}`;
  let url: string;
  let h: Harness;
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    await admin.end();
    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    url = u.toString();
    await runMigrations(url);
    // The same key in two environments, its fingerprint still empty: the start of the application fills it in.
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    await c.query(`insert into environments (id, name) values ('${id(1)}', 'one'), ('${id(2)}', 'two')`);
    await c.query(`insert into consumers (id, environment_id, username) values ('${id(10)}', '${id(1)}', 'app-sky'), ('${id(20)}', '${id(2)}', 'app-sky')`);
    await c.query(`insert into keyauth_credentials (id, environment_id, consumer_id, key, key_hash) values ('${id(11)}', '${id(1)}', '${id(10)}', 'same-legacy-key-0123', null), ('${id(21)}', '${id(2)}', '${id(20)}', 'same-legacy-key-0123', null)`);
    await c.end();
  });

  afterAll(async () => {
    await h?.close();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  });

  it("starts, fills the fingerprints first and leaves the repeated key a blocker, not an instance index", async () => {
    h = await startHarness({ databaseUrl: url });
    const rows = (await h.sql.query(`select key_hash from keyauth_credentials order by id`)).rows;
    expect(rows.every((r) => typeof r.key_hash === "string" && r.key_hash.length > 0)).toBe(true);
    expect(rows[0].key_hash).toBe(rows[1].key_hash);
    const indexes = (await h.sql.query(`select indexname from pg_indexes where indexname = 'keyauth_key_hash_instance_uq'`)).rows;
    expect(indexes).toEqual([]);
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const r = await migrationReport(drizzle(pool, { schema }), h.app.get<Encryptor>(ENCRYPTOR));
      expect(r.status).toBe("blocked");
      expect(r.blockers.map((b) => b.kind)).toEqual(["key-auth-key"]);
    } finally {
      await pool.end();
    }
  });
});
