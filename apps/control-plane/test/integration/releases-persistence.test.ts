import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, runMigrations } from "../../src/db/migrate.js";

// N3-C2: releases and deployments persisted beside v1, which the migration leaves exactly as it was.
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://gromesh:gromesh@127.0.0.1:5432/gromesh";
const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
const N3 = journal.entries.find((e) => e.tag.endsWith("_releases_deployments"))!.idx;
const NEW_TABLES = ["content_activations", "content_revocations", "deployment_lease", "deployments", "releases", "workspace_active_release"];
const NEW_NODE_COLUMNS = ["epoch", "applied_revision", "failed_revision"];

const created: string[] = [];
const folders: string[] = [];

async function freshDatabase(label: string): Promise<string> {
  const name = `gromesh_n3c2_${label}_${Date.now()}_${process.pid}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  created.push(name);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

/** The migrations folder as it was at `idx` (the journal and the SQL files up to it). */
function folderUpTo(idx: number): string {
  const dir = mkdtempSync(join(tmpdir(), "gromesh-n3c2-"));
  folders.push(dir);
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= idx) }));
  for (const e of journal.entries.filter((e) => e.idx > idx)) rmSync(join(dir, `${e.tag}.sql`));
  return dir;
}

async function query(url: string, text: string, values: unknown[] = []) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(text, values)).rows;
  } finally {
    await c.end();
  }
}

/** The SQLSTATE a statement fails with (null: it succeeded). */
async function failure(url: string, text: string, values: unknown[] = []): Promise<string | null> {
  try {
    await query(url, text, values);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (c: string) => `sha256:${c.repeat(64)}`;
const ACTOR = '{"type":"system","id":"seed"}';

/** What v1 holds just before N3-C2: an environment published and served by a cluster with an applied node. */
const V1_SEED = [
  `insert into environments (id, name) values ('${id(1)}', 'Pagamentos'), ('${id(2)}', 'Cadastro')`,
  `insert into services (id, environment_id, name, protocol, host, port, path) values ('${id(10)}', '${id(1)}', 'orders', 'http', 'orders.example.com', 80, '/v1')`,
  `insert into routes (id, environment_id, service_id, name, paths, strip_path) values ('${id(20)}', '${id(1)}', '${id(10)}', 'orders', '{/orders}', true)`,
  `insert into consumers (id, environment_id, username, custom_id) values ('${id(30)}', '${id(1)}', 'app', 'app-1')`,
  `insert into plugins (id, environment_id, name, route_id, config) values ('${id(40)}', '${id(1)}', 'cors', '${id(20)}', '{"origins":["*"]}')`,
  `insert into snapshots (environment_id, version, hash, config, state, message, created_by) values ('${id(1)}', 1, '${sha("1")}', '{"_format_version":"3.0"}', '{"services":[]}', 'v1', '${ACTOR}'), ('${id(1)}', 2, '${sha("2")}', '{"_format_version":"3.0"}', '{"services":[]}', 'v2', '${ACTOR}')`,
  `update environments set current_version = 2 where id = '${id(1)}'`,
  `insert into clusters (id, environment_id, name, registration_token_hash) values ('${id(50)}', '${id(1)}', 'edge', 'reg-1')`,
  `insert into cluster_nodes (cluster_id, node_id, token_hash, hostname, kong_version, agent_version, state, applied_version, applied_hash, failed_version, kong_healthy, reported_at)
     values ('${id(50)}', 'node-a', 'tok-a', 'kong-0', '3.9.4', '1.0.0', 'applied', 2, '${sha("2")}', 1, true, now())`,
  `insert into audit_events (id, actor, action, environment_id, entity_type) values ('${id(60)}', '${ACTOR}', 'snapshot.publish', '${id(1)}', 'snapshot')`,
];

/** Every column, constraint, index and trigger of a table, and its rows ordered by the whole row. */
async function describeTable(url: string, table: string) {
  const columns = await query(
    url,
    `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`,
    [table],
  );
  const names = columns.map((c) => `"${c.column_name as string}"`);
  return {
    columns,
    constraints: await query(url, `select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = $1::regclass order by conname`, [table]),
    indexes: await query(url, `select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = $1 order by indexname`, [table]),
    triggers: await query(url, `select tgname from pg_trigger where tgrelid = $1::regclass and not tgisinternal order by tgname`, [table]),
    rows: await query(url, `select ${names.join(", ")} from "${table}" order by ${names.map((n) => `${n}::text`).join(", ")}`),
  };
}

const tablesOf = async (url: string) =>
  (await query(url, `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`)).map((r) => r.table_name as string);

/** A database migrated up to the migration before N3-C2, holding the v1 seed. */
async function v1Database(label: string): Promise<string> {
  const url = await freshDatabase(label);
  await runMigrations(url, folderUpTo(N3 - 1));
  for (const s of V1_SEED) await query(url, s);
  // As a start of the previous version would: the slugs of the seeded workspaces are filled in.
  await runMigrations(url, folderUpTo(N3 - 1));
  return url;
}

describe("N3-C2 releases and deployments persistence", () => {
  // The v1 database after the N3-C2 migration, for every case but the upgrade itself (which has its own).
  let url: string;

  beforeAll(async () => {
    url = await v1Database("upgraded");
    await runMigrations(url);
  }, 120_000);

  afterAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    for (const name of created) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
    for (const dir of folders) rmSync(dir, { recursive: true, force: true });
  });

  it("is additive: every v1 table keeps its columns, constraints, indexes, triggers and rows", async () => {
    const url = await v1Database("upgrade");
    const v1Tables = await tablesOf(url);
    expect(v1Tables.filter((t) => NEW_TABLES.includes(t))).toEqual([]);
    const before = Object.fromEntries(await Promise.all(v1Tables.map(async (t) => [t, await describeTable(url, t)] as const)));

    // This migration alone: later ones (0022 instance and deployment states, N3-C3) add their own tables.
    await runMigrations(url, folderUpTo(N3));

    expect(await tablesOf(url)).toEqual([...v1Tables, ...NEW_TABLES].sort());
    for (const t of v1Tables) {
      const after = await describeTable(url, t);
      if (t !== "cluster_nodes") {
        expect(after, t).toEqual(before[t]);
        continue;
      }
      // cluster_nodes only gains the N3 columns, nullable and null on the rows v1 wrote.
      const added = after.columns.filter((c) => NEW_NODE_COLUMNS.includes(c.column_name as string));
      expect(added).toEqual(NEW_NODE_COLUMNS.map((column_name) => ({ column_name, data_type: "integer", is_nullable: "YES", column_default: null })));
      expect(after.columns.filter((c) => !NEW_NODE_COLUMNS.includes(c.column_name as string))).toEqual(before[t]!.columns);
      expect({ ...after, columns: undefined, rows: undefined }).toEqual({ ...before[t], columns: undefined, rows: undefined });
      expect(after.rows.map(({ epoch, applied_revision, failed_revision, ...rest }) => [rest, epoch, applied_revision, failed_revision])).toEqual(
        before[t]!.rows.map((r) => [r, null, null, null]),
      );
    }
    // Which clusters a deployment reaches is decision D2: v1 keeps every cluster bound to its environment.
    expect(await query(url, `select is_nullable from information_schema.columns where table_name = 'clusters' and column_name = 'environment_id'`)).toEqual([{ is_nullable: "NO" }]);
  });

  it("keeps v1 writes working, deleting an environment that never had a release included", async () => {
    await query(url, `update cluster_nodes set applied_version = 3, applied_hash = $1, state = 'applied' where node_id = 'node-a'`, [sha("3")]);
    await query(url, `insert into snapshots (environment_id, version, hash, config, state, created_by) values ($1, 3, $2, '{}', '{}', $3)`, [id(1), sha("3"), ACTOR]);
    await query(url, `delete from snapshots where environment_id = $1 and version = 1`, [id(1)]);
    await query(url, `delete from environments where id = $1`, [id(2)]);
    expect(await query(url, `select count(*)::int as n from workspaces where id = $1`, [id(2)])).toEqual([{ n: 0 }]);
  });

  describe("after the migration", () => {
    const release = (version: number, digest: string, extra: Record<string, unknown> = {}) => {
      const row = { workspace_id: id(1), version, content: '{"services":[]}', content_digest: digest, origin: "local", created_by: ACTOR, content_origin_version: version, ...extra };
      const cols = Object.keys(row);
      return query(url, `insert into releases (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row));
    };

    beforeAll(async () => {
      await release(1, sha("a"));
      await release(2, sha("b"));
      // A rollback copy of version 1 keeps its provenance.
      await release(3, sha("a"), { origin: "rollback", rollback_of: 1, content_origin_version: 1 });
      await query(
        url,
        `insert into deployments (epoch, revision, members, expected_nodes, config, config_hash, reason, created_by) values (2, 1, $1, $2, '{"_format_version":"3.0"}', $3, 'publish', $4)`,
        [JSON.stringify([{ workspaceId: id(1), releaseVersion: 3, contentDigest: sha("a") }]), JSON.stringify({ [id(50)]: ["node-a"] }), sha("c"), ACTOR],
      );
      await query(url, `insert into content_activations (workspace_id, content_digest, first_activated_at, deployment_revision) values ($1, $2, now(), 1)`, [id(1), sha("a")]);
      await query(url, `insert into content_revocations (workspace_id, content_digest, reason, revoked_by, revoked_at) values ($1, $2, 'leaked key', $3, now())`, [id(1), sha("b"), ACTOR]);
      await query(url, `insert into workspace_active_release (workspace_id, version, deployment_revision) values ($1, 3, 1)`, [id(1)]);
    });

    it.each([
      ["releases", `update releases set message = 'changed' where version = 1`, `delete from releases where version = 2`],
      ["deployments", `update deployments set reason = 'reconcile'`, `delete from deployments`],
      ["content_activations", `update content_activations set deployment_revision = 2`, `delete from content_activations`],
      ["content_revocations", `update content_revocations set reason = 'other'`, `delete from content_revocations`],
    ])("refuses UPDATE, DELETE and TRUNCATE on %s", async (table, update, del) => {
      const rows = await query(url, `select * from ${table} order by 1, 2`);
      expect(rows.length).toBeGreaterThan(0);
      expect(await failure(url, update)).toBe("55000");
      expect(await failure(url, del)).toBe("55000");
      expect(await failure(url, `truncate ${table} cascade`)).toBe("55000");
      expect(await query(url, `select * from ${table} order by 1, 2`)).toEqual(rows);
    });

    it("refuses deleting a workspace that has releases", async () => {
      expect(await failure(url, `delete from environments where id = $1`, [id(1)])).toBe("23503");
      expect(await query(url, `select count(*)::int as n from releases where workspace_id = $1`, [id(1)])).toEqual([{ n: 3 }]);
    });

    it("keeps the deployment lease a single row, taken and released in place", async () => {
      expect(await query(url, `select id, revision, operation, owner, started_at, deadline_at from deployment_lease`)).toEqual([
        { id: true, revision: null, operation: null, owner: null, started_at: null, deadline_at: null },
      ]);
      expect(await failure(url, `insert into deployment_lease (id) values (true)`)).toBe("23505");
      expect(await failure(url, `insert into deployment_lease (id) values (false)`)).toBe("23514");
      expect(await failure(url, `update deployment_lease set id = false`)).toBe("23514");
      await query(url, `update deployment_lease set revision = 2, operation = 'publish', owner = $1, started_at = now(), deadline_at = now() + interval '5 minutes'`, [ACTOR]);
      await query(url, `update deployment_lease set revision = null, operation = null, owner = null, started_at = null, deadline_at = null`);
      expect(await query(url, `select count(*)::int as n from deployment_lease`)).toEqual([{ n: 1 }]);
    });

    it("moves the active release of a workspace only to one of its releases", async () => {
      await query(url, `update workspace_active_release set version = 2, deployment_revision = 2 where workspace_id = $1`, [id(1)]);
      expect(await failure(url, `update workspace_active_release set version = 9 where workspace_id = $1`, [id(1)])).toBe("23503");
      expect(await query(url, `select version, deployment_revision from workspace_active_release`)).toEqual([{ version: 2, deployment_revision: 2 }]);
    });

    it("checks what the contract fixes on each row", async () => {
      // A promoted release names the promotion that brought it.
      expect(await failure(url, `insert into releases (workspace_id, version, content, content_digest, origin, created_by, content_origin_version) values ($1, 4, '{}', $2, 'promotion', $3, 4)`, [id(1), sha("d"), ACTOR])).toBe("23514");
      expect(await failure(url, `insert into releases (workspace_id, version, content, content_digest, origin, created_by, content_origin_version) values ($1, 4, '{}', $2, 'imported', $3, 4)`, [id(1), sha("d"), ACTOR])).toBe("23514");
      // The first release with a content cannot come after the one carrying it.
      expect(await failure(url, `insert into releases (workspace_id, version, content, content_digest, origin, created_by, content_origin_version) values ($1, 4, '{}', $2, 'local', $3, 5)`, [id(1), sha("d"), ACTOR])).toBe("23514");
      expect(await failure(url, `insert into releases (workspace_id, version, content, content_digest, origin, created_by, content_origin_version) values ($1, 4, '{}', 'sha256:ABC', 'local', $2, 4)`, [id(1), ACTOR])).toBe("23514");
      expect(await failure(url, `insert into releases (workspace_id, version, content, content_digest, origin, created_by, content_origin_version) values ($1, 1, '{}', $2, 'local', $3, 1)`, [id(1), sha("e"), ACTOR])).toBe("23505");
      const deployment = `insert into deployments (epoch, revision, members, expected_nodes, config, config_hash, reason, created_by) values ($1, $2, '[]', '{}', '{}', $3, $4, '${ACTOR}')`;
      expect(await failure(url, deployment, [0, 1, sha("f"), "publish"])).toBe("23514");
      expect(await failure(url, deployment, [2, 2, sha("f"), "manual"])).toBe("23514");
      expect(await failure(url, deployment, [2, 2, "f", "publish"])).toBe("23514");
      expect(await failure(url, deployment, [2, 1, sha("f"), "publish"])).toBe("23505");
      expect(await failure(url, `insert into content_activations (workspace_id, content_digest, first_activated_at, deployment_revision) values ($1, $2, now(), 1)`, [id(1), sha("a")])).toBe("23505");
    });
  });
});
