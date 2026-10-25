import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, runMigrations } from "../../src/db/migrate.js";
import { startHarness, type Harness } from "./harness.js";

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

describe("N1 migration from every earlier version", () => {
  afterAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    for (const name of created) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
    for (const dir of folders) rmSync(dir, { recursive: true, force: true });
  });

  it.each(journal.entries.filter((e) => e.idx < N1).map((e) => [e.idx, e.tag] as const))("upgrades a database at %i (%s)", async (idx) => {
    const url = await freshDatabase(`v${idx}`);
    await runMigrations(url, folderUpTo(idx));
    // environments(id, name) exists since the first migration.
    await query(url, `insert into environments (id, name) values ($1, 'Legado Único'), ($2, 'legado unico')`, [id(1), id(2)]);
    await runMigrations(url);
    expect(await query(url, `select id::text, slug, slug_status, slug_reason from workspaces order by id`)).toEqual([
      { id: id(1), slug: "legado-unico", slug_status: "derived", slug_reason: null },
      { id: id(2), slug: "legado-unico-2", slug_status: "adjusted", slug_reason: "collision" },
    ]);
  });
});
