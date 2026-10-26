import { generateKeyPairSync } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOCK_KEY } from "../../src/crypto/at-rest.js";
import { runMigrations } from "../../src/db/migrate.js";
import { selfSigned } from "./certs.js";
import { type ApiResponse, startHarness, uniq, type Harness } from "./harness.js";

// What Kong looks up across the node is unique in the instance (decision H-5) with several control-plane replicas on
// one Postgres: while an instance index is not in force (a repetition blocks it, or a busy table postponed it), the
// replicas serialize the writers of the kind on a Postgres advisory lock; once in force, the index decides.
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://gromesh:gromesh@127.0.0.1:5432/gromesh";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const KINDS = ["jwt-key", "basic-auth-username", "sni"] as const;
type Kind = (typeof KINDS)[number];
const RSA_PUBLIC = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }) as string;

describe("instance uniqueness with two control-plane replicas on one database", () => {
  const name = `gromesh_uq_replicas_${Date.now()}_${process.pid}`;
  let url: string;
  let sql: pg.Pool;
  const replicas: Harness[] = [];

  const indexes = async () => (await sql.query(`select indexname from pg_indexes where indexname like '%instance_uq' order by indexname`)).rows.map((r) => r.indexname as string);
  /**
   * Each replica writes the same fresh value into a workspace of its own, at once, as a different person (so the
   * per-actor lock does not serialize them: only the kind's lock or the index can).
   */
  const race = async (kind: Kind, [a, b]: Harness[]) => {
    const write = async (h: Harness, value: string): Promise<() => Promise<ApiResponse>> => {
      const env = (await h.api("POST", "/environments", { name: uniq("uq") })).body.id as string;
      const editor = (await h.as("editor")).api;
      if (kind === "sni") {
        const cert = selfSigned(value);
        return () => editor("POST", `/environments/${env}/certificates`, { cert: cert.cert, key: cert.key, snis: [value] });
      }
      const consumer = (await h.api("POST", `/environments/${env}/consumers`, { username: "app" })).body.id as string;
      return kind === "jwt-key"
        ? () => editor("POST", `/environments/${env}/consumers/${consumer}/jwt`, { key: value, algorithm: "RS256", rsaPublicKey: RSA_PUBLIC })
        : () => editor("POST", `/environments/${env}/consumers/${consumer}/basic-auth`, { username: value, password: "a-long-password" });
    };
    const value = kind === "sni" ? `${uniq("race")}.example.com` : uniq("race");
    const [wa, wb] = await Promise.all([write(a!, value), write(b!, value)]);
    const results = await Promise.all([wa!(), wb!()]);
    return { value, results };
  };
  const rows = async (kind: Kind, value: string) => {
    const q = { "jwt-key": `select count(*)::int as n from jwt_credentials where key = $1`, "basic-auth-username": `select count(*)::int as n from basicauth_credentials where username = $1`, sni: `select count(*)::int as n from certificate_snis where name = $1` }[kind];
    return (await sql.query(q, [value])).rows[0].n as number;
  };
  const expectOneWinner = async (kind: Kind, rounds: number) => {
    for (let i = 0; i < rounds; i++) {
      const { value, results } = await race(kind, replicas);
      expect(results.map((r) => r.status).sort(), `${kind} round ${i}: ${JSON.stringify(results.map((r) => r.body))}`).toEqual([201, 409]);
      const lost = results.find((r) => r.status === 409)!;
      // The generic answer: never the other workspace.
      expect(lost.body.detail).toBe("Already in use in this instance");
      expect(await rows(kind, value)).toBe(1);
    }
  };
  const start = () => startHarness({ databaseUrl: url, uniqueConflictMax: 1_000_000 });

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    await admin.end();
    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    url = u.toString();
    await runMigrations(url);
    sql = new pg.Pool({ connectionString: url, max: 3 });
    // Legal before N1: the same JWT key and basic-auth username in two environments, which blocks their indexes.
    await sql.query(`insert into environments (id, name) values ('${id(1)}', 'one'), ('${id(2)}', 'two')`);
    await sql.query(`insert into consumers (id, environment_id, username) values ('${id(10)}', '${id(1)}', 'app'), ('${id(20)}', '${id(2)}', 'app')`);
    await sql.query(`insert into jwt_credentials (id, environment_id, consumer_id, key, algorithm, rsa_public_key) values ('${id(11)}', '${id(1)}', '${id(10)}', 'shared-iss', 'RS256', $1), ('${id(21)}', '${id(2)}', '${id(20)}', 'shared-iss', 'RS256', $1)`, [RSA_PUBLIC]);
    await sql.query(`insert into basicauth_credentials (id, environment_id, consumer_id, username, password_hash) values ('${id(12)}', '${id(1)}', '${id(10)}', 'shared-login', '${"a".repeat(40)}'), ('${id(22)}', '${id(2)}', '${id(20)}', 'shared-login', '${"a".repeat(40)}')`);
  });

  afterAll(async () => {
    await Promise.all(replicas.map((r) => r.close()));
    await sql?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  });

  it("starts a second replica while another one writes (the activation times out), and still lets one writer win", async () => {
    replicas.push(await start());
    // As before N1-X3 put them in force: no instance index at all.
    await sql.query(`drop index certificate_snis_name_instance_uq, keyauth_key_hash_instance_uq`);
    // A writer on the first replica holds the tables: the second start gives up on the indexes after its lock
    // timeout, and nothing else in the start waits for that writer.
    const busy = await sql.connect();
    try {
      await busy.query(`begin`);
      await busy.query(`lock table certificate_snis, keyauth_credentials in row exclusive mode`);
      replicas.push(await start());
    } finally {
      await busy.query(`rollback`);
      busy.release();
    }
    expect(await indexes()).toEqual([]);
    for (const kind of KINDS) await expectOneWinner(kind, 6);
  });

  it("puts the free kinds' indexes in force on a restart, keeps the blocked ones pending, and one writer still wins each", async () => {
    await replicas.shift()!.close();
    replicas.unshift(await start());
    expect(await indexes()).toEqual(["certificate_snis_name_instance_uq", "keyauth_key_hash_instance_uq"]);
    for (const kind of KINDS) await expectOneWinner(kind, 6);
  });

  it("puts every index in force once the last repetition is gone, and the index decides between the replicas", async () => {
    await sql.query(`delete from consumers where id = '${id(20)}'`);
    await replicas.pop()!.close();
    replicas.push(await start());
    expect(await indexes()).toEqual(["basicauth_username_instance_uq", "certificate_snis_name_instance_uq", "jwt_key_instance_uq", "keyauth_key_hash_instance_uq"]);
    for (const kind of KINDS) await expectOneWinner(kind, 6);
  });

  it("refuses a value already taken through either replica, and accepts it again once the holder deletes it", async () => {
    const [a, b] = replicas as [Harness, Harness];
    const envA = (await a.api("POST", "/environments", { name: uniq("uq") })).body.id as string;
    const envB = (await b.api("POST", "/environments", { name: uniq("uq") })).body.id as string;
    const ca = (await a.api("POST", `/environments/${envA}/consumers`, { username: "app" })).body.id as string;
    const cb = (await b.api("POST", `/environments/${envB}/consumers`, { username: "app" })).body.id as string;
    const login = uniq("again");
    const first = await a.api("POST", `/environments/${envA}/consumers/${ca}/basic-auth`, { username: login, password: "a-long-password" });
    expect(first.status).toBe(201);
    for (let i = 0; i < 3; i++) expect((await b.api("POST", `/environments/${envB}/consumers/${cb}/basic-auth`, { username: login, password: "a-long-password" })).status).toBe(409);
    expect((await a.api("DELETE", `/environments/${envA}/consumers/${ca}/basic-auth/${first.body.id}`)).status).toBe(204);
    expect((await b.api("POST", `/environments/${envB}/consumers/${cb}/basic-auth`, { username: login, password: "a-long-password" })).status).toBe(201);
  });

  it("deletes a credential only once it holds the environment's row, the order a rollback takes (no deadlock)", async () => {
    const [a] = replicas as [Harness];
    const envId = (await a.api("POST", "/environments", { name: uniq("uq") })).body.id as string;
    const consumerId = (await a.api("POST", `/environments/${envId}/consumers`, { username: "app" })).body.id as string;
    const cred = (await a.api("POST", `/environments/${envId}/consumers/${consumerId}/basic-auth`, { username: uniq("del"), password: "a-long-password" })).body.id as string;
    const holder = await sql.connect();
    try {
      await holder.query("begin");
      await holder.query(`select id from environments where id = $1 for update`, [envId]);
      const deleting = a.api("DELETE", `/environments/${envId}/consumers/${consumerId}/basic-auth/${cred}`);
      const pid = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid;
      let waiting = false;
      for (let i = 0; i < 200 && !waiting; i++) {
        await new Promise((r) => setTimeout(r, 25));
        waiting = (await sql.query(`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and $1 = any(pg_blocking_pids(pid))`, [pid])).rows[0].n > 0;
      }
      expect(waiting).toBe(true);
      // While it waits for the row, the credential's row is untouched: a rollback holding the environment can delete it.
      const probe = await sql.connect();
      try {
        await probe.query("begin");
        expect((await probe.query(`select id from basicauth_credentials where id = $1 for update nowait`, [cred])).rowCount).toBe(1);
      } finally {
        await probe.query("rollback");
        probe.release();
      }
      await holder.query("commit");
      expect((await deleting).status).toBe(204);
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
  });

  it("reading the migration report on either replica writes nothing", async () => {
    await sql.query(`insert into environments (id, name) values ('${id(3)}', 'Tardio')`);
    const state = () => sql.query(`select (select count(*)::int from workspaces where slug is null) as pending, (select count(*)::int from pg_indexes where indexname like '%instance_uq') as indexes, (select coalesce(max(xmin::text::bigint), 0) from workspaces) as xmin`).then((r) => r.rows[0]);
    const before = await state();
    for (const r of replicas) expect((await r.api("GET", "/../v2/instance/workspace-migration")).status).toBeLessThan(500);
    expect(await state()).toEqual(before);
  });
});

describe("a replica starting while another fills in the key-auth fingerprints (an interrupted 0005)", () => {
  const name = `gromesh_uq_fp_${Date.now()}_${process.pid}`;
  let url: string;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    await admin.end();
    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    url = u.toString();
    await runMigrations(url);
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    await c.query(`insert into environments (id, name) values ('${id(1)}', 'one')`);
    await c.query(`insert into consumers (id, environment_id, username) values ('${id(10)}', '${id(1)}', 'app')`);
    await c.query(`insert into keyauth_credentials (id, environment_id, consumer_id, key, key_hash) values ('${id(11)}', '${id(1)}', '${id(10)}', 'legacy-key-without-print', null)`);
    await c.end();
  });

  afterAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  });

  it("does not serve while another replica completes 0005 (fingerprints, then the index per workspace), and starts after", async () => {
    // The other replica holds the at-rest lock: this start skips the work and must not serve.
    const other = new pg.Client({ connectionString: url });
    await other.connect();
    try {
      await other.query(`select pg_advisory_lock($1)`, [LOCK_KEY]);
      await expect(startHarness({ databaseUrl: url, keyHashWaitMs: 500 })).rejects.toThrow(/not in force yet/);
      // Every fingerprint filled in, the rest of 0005 (NOT NULL, the index per workspace) not yet: still no.
      await other.query(`update keyauth_credentials set key_hash = 'filled-in-by-the-other-replica'`);
      await expect(startHarness({ databaseUrl: url, keyHashWaitMs: 500 })).rejects.toThrow(/not in force yet/);
    } finally {
      await other.end();
    }
    const h = await startHarness({ databaseUrl: url });
    try {
      expect((await h.sql.query(`select count(*)::int as n from keyauth_credentials where key_hash is null`)).rows[0].n).toBe(0);
    } finally {
      await h.close();
    }
  });
});
