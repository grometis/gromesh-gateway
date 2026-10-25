import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, runMigrations } from "../../src/db/migrate.js";
import * as schema from "../../src/db/schema.js";
import { backfillWorkspaces } from "../../src/workspaces/workspaces.js";
import { startHarness, uniq, type Harness } from "./harness.js";

// N1-X1: each environment becomes the workspace with the same id, and nothing the data plane receives changes.
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://gromesh:gromesh@127.0.0.1:5432/gromesh";
const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
const N1 = journal.entries.find((e) => e.tag.endsWith("_workspaces"))!.idx;

const created: string[] = [];
const folders: string[] = [];

async function freshDatabase(label: string): Promise<string> {
  const name = `gromesh_mig_${label}_${Date.now()}_${process.pid}`;
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
  const dir = mkdtempSync(join(tmpdir(), "gromesh-mig-"));
  folders.push(dir);
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const entries = journal.entries.filter((e) => e.idx <= idx);
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
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

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ENVS = [
  { id: id(1), name: "TVRO", slug: "tvro", status: "derived", reason: null },
  { id: id(2), name: "Tvro", slug: "tvro-2", status: "adjusted", reason: "collision" },
  { id: id(3), name: "API", slug: "api-2", status: "adjusted", reason: "reserved" },
  { id: id(4), name: "Gestão de Pagamentos", slug: "gestao-de-pagamentos", status: "derived", reason: null },
];

/** The same rows, valid at 0011 and after it: what the migration must carry over unchanged. */
async function seed(url: string) {
  for (const [i, env] of ENVS.entries()) {
    const n = 100 * (i + 1);
    // created_at orders the backfill: TVRO first, so it keeps the plain slug.
    await query(url, `insert into environments (id, name, created_at) values ($1, $2, now() - make_interval(mins => $3))`, [env.id, env.name, 10 - i]);
    await query(url, `insert into upstreams (id, environment_id, name, healthchecks) values ($1, $2, 'pool', '{"active":null,"passive":null}')`, [id(n + 1), env.id]);
    await query(url, `insert into targets (id, environment_id, upstream_id, target, weight) values ($1, $2, $3, 'backend.example.com:8080', 100)`, [id(n + 2), env.id, id(n + 1)]);
    await query(url, `insert into services (id, environment_id, name, protocol, host, port, path) values ($1, $2, 'orders', 'http', 'pool', 80, '/v1'), ($3, $2, 'echo', 'https', 'echo.example.com', 443, null)`, [id(n + 3), env.id, id(n + 4)]);
    await query(
      url,
      `insert into routes (id, environment_id, service_id, name, paths, hosts, strip_path) values
        ($1, $2, $3, 'with-path', '{/orders}', null, true),
        ($4, $2, $3, 'full-path', '{/keep}', null, false),
        ($5, $2, $6, 'host-only', null, '{echo.example.com}', true)`,
      [id(n + 5), env.id, id(n + 3), id(n + 6), id(n + 7), id(n + 4)],
    );
    // The same logical consumer in two environments: independent consumers (decision H-5).
    await query(url, `insert into consumers (id, environment_id, username, custom_id, acl_groups) values ($1, $2, 'app-sky', 'sky-1', '{gold}')`, [id(n + 8), env.id]);
    await query(url, `insert into plugins (id, environment_id, name, route_id, config) values ($1, $2, 'cors', $3, '{"origins":["https://example.com"]}')`, [id(n + 9), env.id, id(n + 5)]);
  }
}

async function draftHashes(h: Harness) {
  const out: Record<string, string> = {};
  for (const env of ENVS) {
    const res = await h.api("GET", `/environments/${env.id}/publish-preview`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    out[env.name] = res.body.draftHash;
  }
  return out;
}

const ENTITY_TABLES = ["environments", "services", "routes", "upstreams", "targets", "consumers", "plugins"];
async function ids(url: string) {
  const out: Record<string, string[]> = {};
  for (const t of ENTITY_TABLES) out[t] = (await query(url, `select id::text from ${t} order by id`)).map((r) => r.id);
  return out;
}

describe("N1 workspaces migration", () => {
  let migrated: string;
  let native: string;
  let hMigrated: Harness;
  let hNative: Harness;

  beforeAll(async () => {
    // Migrated: the pre-N1 schema with data, then the N1 migration on top of it.
    migrated = await freshDatabase("migrated");
    await runMigrations(migrated, folderUpTo(N1 - 1));
    await seed(migrated);
    await runMigrations(migrated);
    // Native: the same rows written after every migration, as a fresh installation would hold them.
    native = await freshDatabase("native");
    await runMigrations(native);
    await seed(native);
    await query(native, `delete from workspaces`);
    await query(native, `insert into workspaces (id) select id from environments`);
    await runMigrations(native);
    hMigrated = await startHarness({ databaseUrl: migrated });
    hNative = await startHarness({ databaseUrl: native });
  });

  afterAll(async () => {
    await hMigrated?.close();
    await hNative?.close();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    for (const name of created) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
    for (const dir of folders) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps every id and every compiled configuration: the draft hash of each environment is unchanged", async () => {
    expect(await ids(migrated)).toEqual(await ids(native));
    const before = await draftHashes(hNative);
    const after = await draftHashes(hMigrated);
    expect(after).toEqual(before);
    // Distinct environments compile to distinct configurations (the comparison is not vacuous).
    expect(new Set(Object.values(after)).size).toBe(ENVS.length);
  });

  it("makes each environment the workspace with the same id, with a reviewed slug", async () => {
    const rows = await query(migrated, `select w.id::text, w.slug, w.slug_status, w.slug_reason, w.status, w.migrated_at is not null as migrated, w.slug_locked_at from workspaces w order by w.id`);
    expect(rows).toEqual(
      ENVS.map((e) => ({ id: e.id, slug: e.slug, slug_status: e.status, slug_reason: e.reason, status: "active", migrated: true, slug_locked_at: null })),
    );
    const keys = await query(migrated, `select count(distinct key)::int as n from workspaces`);
    expect(keys[0].n).toBe(ENVS.length);
    expect(await query(migrated, `select name from data_migrations`)).toEqual([{ name: "n1-workspaces" }]);
  });

  it("keeps every existing route legacy-preserved, routes without a path included", async () => {
    const rows = await query(migrated, `select name, path_compatibility, strip_path from routes where environment_id = $1 order by name`, [ENVS[0]!.id]);
    expect(rows).toEqual([
      { name: "full-path", path_compatibility: "legacy-preserved", strip_path: false },
      { name: "host-only", path_compatibility: "legacy-preserved", strip_path: true },
      { name: "with-path", path_compatibility: "legacy-preserved", strip_path: true },
    ]);
  });

  it("is idempotent: running the migrations again changes nothing", async () => {
    const before = await query(migrated, `select id::text, slug, key::text, updated_at from workspaces order by id`);
    await runMigrations(migrated);
    expect(await query(migrated, `select id::text, slug, key::text, updated_at from workspaces order by id`)).toEqual(before);
  });

  it("gives every new environment its workspace and slug in the same transaction", async () => {
    const res = await hMigrated.api("POST", "/environments", { name: "tvro." });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [row] = await query(migrated, `select slug, slug_status, slug_reason, migrated_at from workspaces where id = $1`, [res.body.id]);
    expect(row).toEqual({ slug: "tvro-3", slug_status: "adjusted", slug_reason: "collision", migrated_at: null });
    // The v1 representation does not change.
    expect(Object.keys(res.body).sort()).toEqual(["autoPublishPausedReason", "createdAt", "currentVersion", "description", "hasUnpublishedChanges", "id", "name", "publishMode", "updatedAt"]);
    // Renaming keeps the slug; deleting the environment deletes its workspace.
    expect((await hMigrated.api("PATCH", `/environments/${res.body.id}`, { name: "outro-nome" })).status).toBe(200);
    expect((await query(migrated, `select slug from workspaces where id = $1`, [res.body.id]))[0].slug).toBe("tvro-3");
    expect((await hMigrated.api("DELETE", `/environments/${res.body.id}`)).status).toBe(204);
    expect(await query(migrated, `select 1 from workspaces where id = $1`, [res.body.id])).toEqual([]);
  });

  it("refuses in the database what the model forbids", async () => {
    const env = ENVS[0]!.id;
    const refuse = async (text: string, values: unknown[], constraint: RegExp) => {
      await expect(query(migrated, text, values)).rejects.toThrow(constraint);
    };
    await refuse(`update workspaces set slug = 'Bad_Slug' where id = $1`, [env], /workspaces_slug_ck/);
    await refuse(`update workspaces set slug = 'tvro-2' where id = $1`, [env], /workspaces_slug_uq/);
    await refuse(`update workspaces set slug_status = 'adjusted' where id = $1`, [env], /workspaces_slug_status_ck/);
    await refuse(`update workspaces set slug_reason = 'collision' where id = $1`, [env], /workspaces_slug_status_ck/);
    await refuse(`update workspaces set status = 'deleted' where id = $1`, [env], /workspaces_status_ck/);
    await refuse(`insert into workspaces (id) values ($1)`, [id(999)], /workspaces_id_environments_id_fk/);
    await refuse(`update routes set path_compatibility = 'workspace-default' where id = $1`, [id(107)], /routes_workspace_default_paths_ck/);
    await refuse(`update routes set path_compatibility = 'other' where id = $1`, [id(105)], /routes_path_compatibility_ck/);
    // A route with a path may become the workspace default (convertRoutePathCompatibility does it, N1-C2).
    expect(await query(migrated, `update routes set path_compatibility = 'workspace-default' where id = $1 returning id::text`, [id(105)])).toEqual([{ id: id(105) }]);
    await query(migrated, `update routes set path_compatibility = 'legacy-preserved' where id = $1`, [id(105)]);
  });
});

/**
 * What each earlier version could hold, written with the columns that version had (a block applies from the migration
 * that created its tables on); after the N1 migrations every row must read back unchanged.
 */
const VERSION_SEED: { since: number; table: string; sql: string }[] = [
  { since: 0, table: "environments", sql: `insert into environments (id, name) values ('${id(1)}', 'Legado Único'), ('${id(2)}', 'legado unico')` },
  { since: 0, table: "services", sql: `insert into services (id, environment_id, name, protocol, host, port, path) values ('${id(10)}', '${id(1)}', 'svc', 'http', 'a.example.com', 80, '/v1'), ('${id(11)}', '${id(2)}', 'svc', 'https', 'b.example.com', 443, null)` },
  { since: 0, table: "routes", sql: `insert into routes (id, environment_id, service_id, name, paths, hosts, strip_path, preserve_host) values ('${id(20)}', '${id(1)}', '${id(10)}', 'with-path', '{/a}', null, true, false), ('${id(21)}', '${id(1)}', '${id(10)}', 'host-only', null, '{a.example.com}', true, true), ('${id(22)}', '${id(2)}', '${id(11)}', 'full', '{/b}', null, false, false)` },
  { since: 0, table: "audit_events", sql: `insert into audit_events (id, actor, action, environment_id, entity_type) values ('${id(30)}', '{"type":"system","id":"seed"}', 'seed', '${id(1)}', 'environment')` },
  { since: 2, table: "consumers", sql: `insert into consumers (id, environment_id, username, custom_id) values ('${id(40)}', '${id(1)}', 'app-sky', 'sky-1'), ('${id(41)}', '${id(2)}', 'app-sky', 'sky-1')` },
  { since: 2, table: "plugins", sql: `insert into plugins (id, environment_id, name, route_id, config) values ('${id(50)}', '${id(1)}', 'cors', '${id(20)}', '{"origins":["*"]}'), ('${id(51)}', '${id(2)}', 'rate-limiting', null, '{"minute":5}')` },
  { since: 3, table: "clusters", sql: `insert into clusters (id, environment_id, name, registration_token_hash) values ('${id(60)}', '${id(1)}', 'edge', 'h1'), ('${id(61)}', '${id(2)}', 'edge', 'h2')` },
  { since: 4, table: "users", sql: `insert into users (id, email, name, role, password_hash) values ('${id(70)}', 'u@example.com', 'U', 'editor', 'x')` },
  { since: 7, table: "upstreams", sql: `insert into upstreams (id, environment_id, name, healthchecks) values ('${id(80)}', '${id(1)}', 'pool', '{"active":null,"passive":null}')` },
  { since: 7, table: "targets", sql: `insert into targets (id, environment_id, upstream_id, target) values ('${id(81)}', '${id(1)}', '${id(80)}', 'backend.example.com:8080')` },
  { since: 7, table: "certificates", sql: `insert into certificates (id, environment_id, cert, key, subject, issuer, not_before, not_after, fingerprint_sha256) values ('${id(90)}', '${id(2)}', 'c', 'k', 'CN=b', 'CN=b', '2026-01-01', '2027-01-01', 'f')` },
  { since: 7, table: "certificate_snis", sql: `insert into certificate_snis (environment_id, certificate_id, name) values ('${id(2)}', '${id(90)}', 'b.example.com')` },
  { since: 8, table: "jwt_credentials", sql: `insert into jwt_credentials (id, environment_id, consumer_id, key, algorithm, rsa_public_key) values ('${id(100)}', '${id(1)}', '${id(40)}', 'issuer-1', 'RS256', 'pem')` },
  { since: 8, table: "basicauth_credentials", sql: `insert into basicauth_credentials (id, environment_id, consumer_id, username, password_hash) values ('${id(101)}', '${id(2)}', '${id(41)}', 'login-2', 'h')` },
  { since: 10, table: "environment_roles", sql: `insert into environment_roles (user_id, environment_id, role) values ('${id(70)}', '${id(2)}', 'none')` },
];

describe("N1 migration from every earlier version", () => {
  afterAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    for (const name of created) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
    for (const dir of folders) rmSync(dir, { recursive: true, force: true });
  });

  it.each(journal.entries.filter((e) => e.idx < N1).map((e) => [e.idx, e.tag] as const))("upgrades a database at %i (%s) without changing a row", async (idx) => {
    const url = await freshDatabase(`v${idx}`);
    await runMigrations(url, folderUpTo(idx));
    const blocks = VERSION_SEED.filter((b) => b.since <= idx);
    for (const b of blocks) await query(url, b.sql);
    // Every column the version had, row by row, ordered by the whole row.
    const read = async (table: string, columns: string[]) => query(url, `select ${columns.map((c) => `"${c}"`).join(", ")} from ${table} order by ${columns.map((c) => `"${c}"::text`).join(", ")}`);
    const tables = [...new Set(blocks.map((b) => b.table))];
    const before: Record<string, { columns: string[]; rows: unknown[] }> = {};
    for (const t of tables) {
      const columns = (await query(url, `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`, [t])).map((r) => r.column_name as string);
      before[t] = { columns, rows: await read(t, columns) };
    }
    await runMigrations(url);
    for (const t of tables) expect(await read(t, before[t]!.columns), t).toEqual(before[t]!.rows);
    expect(await query(url, `select id::text, slug, slug_status, slug_reason from workspaces order by id`)).toEqual([
      { id: id(1), slug: "legado-unico", slug_status: "derived", slug_reason: null },
      { id: id(2), slug: "legado-unico-2", slug_status: "adjusted", slug_reason: "collision" },
    ]);
    expect(await query(url, `select distinct path_compatibility from routes`)).toEqual([{ path_compatibility: "legacy-preserved" }]);
    expect(await query(url, `select name from data_migrations`)).toEqual([{ name: "n1-workspaces" }]);
    // Every environment role is the v1 binding of its workspace (N1-C3): none a deny.
    const bindings = await query(url, `select subject_id::text, workspace_id::text, role, effect, origin from role_bindings order by subject_id`);
    expect(bindings).toEqual(idx >= 10 ? [{ subject_id: id(70), workspace_id: id(2), role: null, effect: "deny", origin: "v1-environment-role" }] : []);
  });
});

/**
 * The real "before": a database written by the pre-N1 code (main 843b658: four environments with services, upstreams,
 * targets, routes with and without a path, consumers with key-auth/JWT/basic-auth credentials and ACL groups, plugins,
 * certificates, two published versions each and a pending draft in two of them), dumped with pg_dump, and the snapshot
 * and draft hashes that code computed. The fixture's secrets are sealed with the harness's test keys.
 */
const FIXTURE = new URL("./fixtures/", import.meta.url);
const before = JSON.parse(readFileSync(new URL("pre-n1.json", FIXTURE), "utf8")) as {
  environments: { id: string; name: string; draftHash: string; hasChanges: boolean; snapshots: { version: number; hash: string }[] }[];
};
const dump = readFileSync(new URL("pre-n1.sql", FIXTURE), "utf8");
// pg_dump's psql meta-commands (\restrict) are not SQL.
const dumpSql = dump.split("\n").filter((l) => !l.startsWith("\\")).join("\n");
const dumpCounts = (table: string) => dump.split(`INSERT INTO public.${table} `).length - 1;

async function restorePreN1(label: string): Promise<string> {
  const url = await freshDatabase(label);
  await query(url, dumpSql);
  return url;
}

describe("N1 migration of a database written by the pre-N1 code", () => {
  let url: string;
  let h: Harness;

  beforeAll(async () => {
    url = await restorePreN1("pre_n1");
    await runMigrations(url);
    h = await startHarness({ databaseUrl: url });
  });

  afterAll(async () => {
    await h?.close();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    for (const name of created) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  });

  it("keeps every row", async () => {
    for (const table of ["environments", "services", "routes", "upstreams", "targets", "consumers", "keyauth_credentials", "jwt_credentials", "basicauth_credentials", "plugins", "certificates", "certificate_snis", "snapshots", "users"]) {
      const [{ n }] = await query(url, `select count(*)::int as n from ${table}`);
      expect(n, table).toBe(dumpCounts(table));
    }
    // The harness's own login adds events; every event of the dump is still there.
    const dumped = [...dump.matchAll(/INSERT INTO public\.audit_events VALUES \('([0-9a-f-]{36})'/g)].map((m) => m[1]);
    expect(dumped.length).toBe(dumpCounts("audit_events"));
    const [{ n }] = await query(url, `select count(*)::int as n from audit_events where id = any($1::uuid[])`, [dumped]);
    expect(n).toBe(dumped.length);
  });

  it("keeps every published version and the draft exactly as the old code computed them", async () => {
    for (const env of before.environments) {
      const snapshots = await h.api("GET", `/environments/${env.id}/snapshots`);
      expect(snapshots.body.items.map((s: { version: number; hash: string }) => ({ version: s.version, hash: s.hash })), env.name).toEqual(env.snapshots);
      const preview = await h.api("GET", `/environments/${env.id}/publish-preview`);
      expect({ draftHash: preview.body.draftHash, hasChanges: preview.body.hasChanges }, env.name).toEqual({ draftHash: env.draftHash, hasChanges: env.hasChanges });
    }
  });

  it("publishes the same configuration the old code would have, and rolls back to the old versions", async () => {
    for (const env of before.environments) {
      const published = await h.api("POST", `/environments/${env.id}/snapshots`, { message: "after N1" });
      if (env.hasChanges) {
        expect(published.status, env.name).toBe(201);
        expect(published.body.hash, env.name).toBe(env.draftHash);
      } else {
        // The draft compiles to the current version's configuration: nothing to publish.
        expect(published.status, env.name).toBe(409);
      }
      const rolled = await h.api("POST", `/environments/${env.id}/snapshots/1/rollback`);
      expect(rolled.status, `${env.name}: ${JSON.stringify(rolled.body)}`).toBe(201);
      expect(rolled.body.hash, env.name).toBe(env.snapshots.find((s) => s.version === 1)!.hash);
    }
    const [{ n }] = await query(url, `select count(*)::int as n from routes where path_compatibility <> 'legacy-preserved'`);
    expect(n).toBe(0);
  });

  it("gives every environment its workspace and slug", async () => {
    const rows = await query(url, `select e.name, w.slug, w.slug_status, w.slug_reason, w.migrated_at is not null as migrated from workspaces w join environments e using (id) order by e.created_at`);
    expect(rows).toEqual([
      { name: "TVRO", slug: "tvro", slug_status: "derived", slug_reason: null, migrated: true },
      { name: "tvro.", slug: "tvro-2", slug_status: "adjusted", slug_reason: "collision", migrated: true },
      { name: "api", slug: "api-2", slug_status: "adjusted", slug_reason: "reserved", migrated: true },
      { name: "Pagamentos_PIX", slug: "pagamentos-pix", slug_status: "derived", slug_reason: null, migrated: true },
    ]);
  });
});

describe("N1 slug backfill under interruption, concurrency and an older replica", () => {
  afterAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    for (const name of created) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  });

  /** The SQL migrations only, as a process killed before the backfill would leave them. */
  async function sqlOnly(url: string) {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    } finally {
      await pool.end();
    }
  }
  const state = (url: string) => query(url, `select (select count(*)::int from workspaces where slug is null) as pending, (select count(*)::int from data_migrations where name = 'n1-workspaces') as done`);

  it("records the data migration only once no workspace lacks a slug, and finishes it when run again", async () => {
    const url = await restorePreN1("interrupted");
    await sqlOnly(url);
    expect(await state(url)).toEqual([{ pending: 4, done: 0 }]);
    await runMigrations(url);
    expect(await state(url)).toEqual([{ pending: 0, done: 1 }]);
  });

  it("gives the same slugs when two replicas backfill at once", async () => {
    const url = await restorePreN1("concurrent");
    await sqlOnly(url);
    const pools = [new pg.Pool({ connectionString: url, max: 1 }), new pg.Pool({ connectionString: url, max: 1 })];
    try {
      const done = await Promise.all(pools.map((p) => drizzle(p, { schema }).transaction((tx) => backfillWorkspaces(tx))));
      // The advisory lock serializes them: one fills the four slugs, the other finds nothing left.
      expect(done.sort()).toEqual([0, 4]);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
    expect((await query(url, `select slug from workspaces order by slug`)).map((r) => r.slug)).toEqual(["api-2", "pagamentos-pix", "tvro", "tvro-2"]);
  });

  it("fills in, on the next start, the slug of an environment an older replica created after the migration", async () => {
    const url = await restorePreN1("old_replica");
    await runMigrations(url);
    // The previous version inserts the environment without knowing about slugs; the trigger creates its workspace.
    await query(url, `insert into environments (id, name) values ($1, 'legacy-writer')`, [id(77)]);
    expect(await query(url, `select slug from workspaces where id = $1`, [id(77)])).toEqual([{ slug: null }]);
    const h = await startHarness({ databaseUrl: url, migrateOnStart: false });
    try {
      expect(await query(url, `select slug, slug_status from workspaces where id = $1`, [id(77)])).toEqual([{ slug: "legacy-writer", slug_status: "derived" }]);
    } finally {
      await h.close();
    }
  });
});

describe("N1 slug reconciliation while running", () => {
  afterAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    for (const name of created) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  });

  it("fills in the slug of an environment an older replica creates while the new replicas are running", async () => {
    const url = await restorePreN1("running");
    await runMigrations(url);
    const h = await startHarness({ databaseUrl: url, workspaceSlugPollMs: 50 });
    try {
      await query(url, `insert into environments (id, name) values ($1, 'late-legacy-writer')`, [id(78)]);
      let slug: string | null = null;
      for (let i = 0; i < 100 && slug === null; i++) {
        await new Promise((r) => setTimeout(r, 50));
        slug = (await query(url, `select slug from workspaces where id = $1`, [id(78)]))[0].slug;
      }
      expect(slug).toBe("late-legacy-writer");
    } finally {
      await h.close();
    }
  });
});

describe("one data plane serves one workspace", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  it("gives each environment's clusters only that workspace's configuration", async () => {
    const agent = async (path: string, token: string, body?: unknown) =>
      fetch(`${await h.app.getUrl()}/agent/v1/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const nodes: { env: string; token: string; hash: string }[] = [];
    for (const name of [uniq("dp-a"), uniq("dp-b")]) {
      const env = (await h.api("POST", "/environments", { name })).body.id as string;
      const svc = (await h.api("POST", `/environments/${env}/services`, { name: "svc", protocol: "http", host: `${name}.example.com`, port: 80 })).body.id;
      await h.api("POST", `/environments/${env}/routes`, { name: "r", serviceId: svc, paths: ["/r"] });
      const hash = (await h.api("POST", `/environments/${env}/snapshots`, {})).body.hash as string;
      const cluster = (await h.api("POST", `/environments/${env}/clusters`, { name: "edge" })).body;
      const registered = await agent("register", cluster.registrationToken, { nodeId: "n1", hostname: "h", kongVersion: "3.9.4", agentVersion: "0.1.0" });
      expect(registered.status).toBe(200);
      nodes.push({ env, token: ((await registered.json()) as { nodeToken: string }).nodeToken, hash });
    }
    for (const node of nodes) {
      const current = await agent("snapshots/current", node.token);
      expect(current.status).toBe(200);
      const body = (await current.json()) as { environmentId: string; hash: string };
      expect({ environmentId: body.environmentId, hash: body.hash }).toEqual({ environmentId: node.env, hash: node.hash });
    }
    expect(nodes[0]!.hash).not.toBe(nodes[1]!.hash);
    // A cluster belongs to exactly one environment, in the database.
    const [{ nullable }] = (await h.sql.query(`select is_nullable as nullable from information_schema.columns where table_name = 'clusters' and column_name = 'environment_id'`)).rows;
    expect(nullable).toBe("NO");
  });
});

describe("path compatibility through rollback and import", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  it("restores a version's workspace-default routes exactly, and an import keeps the classification of the routes it keeps", async () => {
    const env = (await h.api("POST", "/environments", { name: uniq("pc") })).body.id as string;
    const e = `/environments/${env}`;
    const svc = (await h.api("POST", `${e}/services`, { name: "svc", protocol: "http", host: "a.example.com", port: 80 })).body.id;
    const route = (await h.api("POST", `${e}/routes`, { name: "r", serviceId: svc, paths: ["/r"] })).body.id;
    const cls = async () => (await h.sql.query(`select path_compatibility as c from routes where id = $1`, [route])).rows[0]?.c;
    expect(await cls()).toBe("legacy-preserved");
    // Only v2 (N1-X4) and convertRoutePathCompatibility (N1-C2) make a route workspace-default; here the database does.
    await h.sql.query(`update routes set path_compatibility = 'workspace-default' where id = $1`, [route]);
    expect((await h.api("POST", `${e}/snapshots`, { message: "v1" })).status).toBe(201);
    expect((await h.sql.query(`select workspace_default_routes::text[] as r from snapshots where environment_id = $1 and version = 1`, [env])).rows[0].r).toEqual([route]);
    await h.sql.query(`update routes set path_compatibility = 'legacy-preserved' where id = $1`, [route]);
    await h.api("POST", `${e}/routes`, { name: "r2", serviceId: svc, paths: ["/r2"] });
    expect((await h.api("POST", `${e}/snapshots`, { message: "v2" })).status).toBe(201);
    expect((await h.api("POST", `${e}/snapshots/1/rollback`)).status).toBe(201);
    expect(await cls()).toBe("workspace-default");
    expect((await h.api("POST", `${e}/snapshots/2/rollback`)).status).toBe(201);
    expect(await cls()).toBe("legacy-preserved");

    await h.sql.query(`update routes set path_compatibility = 'workspace-default' where id = $1`, [route]);
    const doc = (await h.api("GET", `${e}/export?format=json`)).body;
    doc.routes.push({ name: "r3", service: "svc", paths: ["/r3"] });
    const imported = await h.api("POST", `${e}/import`, { mode: "merge", document: doc, dryRun: false });
    expect(imported.status, JSON.stringify(imported.body)).toBe(200);
    expect(await cls()).toBe("workspace-default");
    const r3 = (await h.sql.query(`select path_compatibility as c from routes where environment_id = $1 and name = 'r3'`, [env])).rows[0].c;
    expect(r3).toBe("legacy-preserved");

    // Removing the path of a workspace-default route is the same error in a dry run (its report, 200) and for real (422).
    const without = (await h.api("GET", `${e}/export?format=json`)).body;
    const index = without.routes.findIndex((r: { name: string }) => r.name === "r");
    without.routes[index] = { ...without.routes[index], paths: [], hosts: ["r.example.com"] };
    const error = { path: `document.routes.${index}.paths`, message: "required for a workspace-default route" };
    const dry = await h.api("POST", `${e}/import`, { mode: "merge", document: without, dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.errors).toContainEqual(error);
    expect(dry.body.modified).toEqual([]);
    const real = await h.api("POST", `${e}/import`, { mode: "merge", document: without, dryRun: false });
    expect(real.status).toBe(422);
    expect(real.body.errors).toContainEqual(error);
    expect(await cls()).toBe("workspace-default");
  });
});
