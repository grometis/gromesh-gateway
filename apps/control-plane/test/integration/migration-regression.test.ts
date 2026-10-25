import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { effectiveRole, type EnvironmentRole, RANK, type Role } from "../../src/auth/environment-access.js";
import { permissionsIn, requiredPermission } from "../../src/auth/permissions.js";
import { MIGRATIONS_DIR, runMigrations } from "../../src/db/migrate.js";
import * as schema from "../../src/db/schema.js";
import { startHarness } from "./harness.js";

// N1-C4: the N1 migration against what the previous version wrote — the access matrix it decided, the way back
// (the backup taken before the migration, restored on a copy) and the time it takes on a large database.
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://gromesh:gromesh@127.0.0.1:5432/gromesh";
const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
const N1 = journal.entries.find((e) => e.tag.endsWith("_workspaces"))!.idx;

const FIXTURE = new URL("./fixtures/", import.meta.url);
const before = JSON.parse(readFileSync(new URL("pre-n1.json", FIXTURE), "utf8")) as { environments: { id: string; draftHash: string }[] };
// pg_dump's psql meta-commands (\restrict) are not SQL.
const dumpSql = readFileSync(new URL("pre-n1.sql", FIXTURE), "utf8").split("\n").filter((l) => !l.startsWith("\\")).join("\n");

const created: string[] = [];
const folders: string[] = [];

async function freshDatabase(label: string): Promise<string> {
  const name = `gromesh_reg_${label}_${Date.now()}_${process.pid}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  created.push(name);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
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

/** The migrations folder as the previous version shipped it (up to the last migration before N1). */
function previousVersionFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "gromesh-reg-"));
  folders.push(dir);
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx < N1) }));
  for (const e of journal.entries.filter((e) => e.idx >= N1)) rmSync(join(dir, `${e.tag}.sql`));
  return dir;
}

/**
 * pg_dump and psql of the server's own version: on PATH (CI), or through GROMESH_PG_TOOLS, a command prefix such as
 * "docker exec -i gromesh-postgres-1" that runs them next to the server (they then use its local socket).
 */
function pgTool(tool: "pg_dump" | "psql", url: string, args: string[], input?: string): string {
  const u = new URL(url);
  const prefix = (process.env.GROMESH_PG_TOOLS ?? "").split(" ").filter(Boolean);
  const connection = prefix.length > 0 ? ["-U", decodeURIComponent(u.username)] : ["-h", u.hostname, "-p", u.port || "5432", "-U", decodeURIComponent(u.username)];
  const [cmd, ...rest] = [...prefix, tool, ...connection, "-d", u.pathname.slice(1), ...args];
  return execFileSync(cmd!, rest, { input, env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) }, maxBuffer: 1 << 30, encoding: "utf8" });
}
/** A plain dump, without the random \restrict line pg_dump adds: two dumps of the same data compare equal. */
const backup = (url: string) => pgTool("pg_dump", url, ["--format=plain", "--no-owner", "--no-privileges"]);
const comparable = (dump: string) => dump.split("\n").filter((l) => !l.startsWith("\\restrict") && !l.startsWith("\\unrestrict")).join("\n");
const restore = (url: string, dump: string) => pgTool("psql", url, ["-v", "ON_ERROR_STOP=1", "-q", "-X"], dump);

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const GLOBAL: Role[] = ["viewer", "editor", "admin"];
const OVERRIDE: (EnvironmentRole | undefined)[] = [undefined, "none", "viewer", "editor", "admin"];

/** Users as the previous version wrote them: every global role with every environment role, on half the environments. */
async function seedAccess(url: string): Promise<{ id: string; role: Role; overrides: Map<string, EnvironmentRole> }[]> {
  const envs = (await query(url, `select id from environments order by id`)).map((r) => r.id as string);
  const out: { id: string; role: Role; overrides: Map<string, EnvironmentRole> }[] = [];
  let n = 900;
  for (const role of GLOBAL) {
    for (const override of OVERRIDE) {
      const id = uid(++n);
      await query(url, `insert into users (id, email, name, role, password_hash) values ($1, $2, $3, $4, 'x')`, [id, `u${n}@example.com`, `u${n}`, role]);
      const overrides = new Map<string, EnvironmentRole>();
      if (override !== undefined) {
        for (const env of envs.filter((_, i) => i % 2 === 0)) {
          await query(url, `insert into environment_roles (user_id, environment_id, role) values ($1, $2, $3)`, [id, env, override]);
          overrides.set(env, override);
        }
      }
      out.push({ id, role, overrides });
    }
  }
  return out;
}

afterAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  for (const name of created) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
  for (const dir of folders) rmSync(dir, { recursive: true, force: true });
});

describe("the access matrix the previous version decided, after the migration", () => {
  it("decides every user × environment × required role exactly as before: nothing widened, nothing lost", async () => {
    const url = await freshDatabase("rbac");
    await query(url, dumpSql);
    const people = await seedAccess(url);
    const envs = (await query(url, `select id from environments order by id`)).map((r) => r.id as string);
    await runMigrations(url);
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    const db = drizzle(pool, { schema });
    let decisions = 0;
    try {
      for (const person of people) {
        const [user] = await db.select().from(schema.users).where(eq(schema.users.id, person.id));
        // Outside any environment: the global role.
        const instance = await permissionsIn(db, user!, { type: "instance" });
        for (const required of GLOBAL) {
          expect(instance.has(requiredPermission(required, false)), `${person.role} at instance, ${required}`).toBe(RANK[person.role] >= RANK[required]);
          decisions++;
        }
        for (const env of envs) {
          const old = effectiveRole(user!, person.overrides.get(env));
          const held = await permissionsIn(db, user!, { type: "workspace", workspaceId: env });
          const label = `${person.role}/${person.overrides.get(env) ?? "-"} in ${env}`;
          expect(held.has("workspace.read"), `${label}: visible`).toBe(old !== "none");
          for (const required of GLOBAL) {
            expect(held.has(requiredPermission(required, true)), `${label}: ${required}`).toBe(old !== "none" && RANK[old] >= RANK[required]);
            decisions++;
          }
        }
      }
    } finally {
      await pool.end();
    }
    expect(decisions).toBe(people.length * GLOBAL.length * (1 + envs.length));
  });
});

// It needs pg_dump and psql of the server's version: the migration-regression job of the CI provides them (and
// MIGRATION_REGRESSION=1); elsewhere set both to run it.
describe.runIf(process.env.MIGRATION_REGRESSION === "1")("the way back: the backup taken before the migration, restored on a copy", () => {
  let source: string;
  let restored: string;
  let taken: string;

  beforeAll(async () => {
    source = await freshDatabase("source");
    await query(source, dumpSql);
    await seedAccess(source);
    taken = backup(source);
    // The migration, then the new version at work: what it writes after the backup is what going back gives up.
    await runMigrations(source);
    const h = await startHarness({ databaseUrl: source });
    try {
      const env = before.environments[0]!.id;
      expect((await h.api("POST", `/environments/${env}/consumers`, { username: "after-n1" })).status).toBe(201);
    } finally {
      await h.close();
    }
    restored = await freshDatabase("restored");
    restore(restored, taken);
  });

  it("gives back exactly the database the previous version ran on", async () => {
    expect(comparable(backup(restored))).toBe(comparable(taken));
    expect(await query(restored, `select to_regclass('public.workspaces') is null as gone, (select count(*)::int from drizzle.__drizzle_migrations) as applied`)).toEqual([{ gone: true, applied: N1 }]);
    expect(await query(restored, `select count(*)::int as n from consumers where username = 'after-n1'`)).toEqual([{ n: 0 }]);
  });

  it("migrates again from the restored copy to the same configuration the previous version computed", async () => {
    await runMigrations(restored);
    const h = await startHarness({ databaseUrl: restored });
    try {
      for (const env of before.environments) {
        const res = await h.api("GET", `/environments/${env.id}/publish-preview`);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.draftHash, env.id).toBe(env.draftHash);
      }
    } finally {
      await h.close();
    }
  });
});

describe("the time the migration takes on a large database", () => {
  // MIGRATION_SCALE environments, each with 50 services (2 routes and 2 plugins each), 50 consumers and an upstream
  // with 5 targets: 20 by default, more in the regression job.
  const scale = Number(process.env.MIGRATION_SCALE ?? 20);

  it("migrates every row within the bound and reports the time", { timeout: 600_000 }, async () => {
    const url = await freshDatabase("large");
    await runMigrations(url, previousVersionFolder());
    await query(
      url,
      `insert into environments (id, name) select gen_random_uuid(), 'env-' || e from generate_series(1, $1::int) e;
       insert into upstreams (id, environment_id, name, healthchecks) select gen_random_uuid(), id, 'pool', '{"active":null,"passive":null}' from environments;
       insert into targets (id, environment_id, upstream_id, target, weight) select gen_random_uuid(), u.environment_id, u.id, 'backend-' || t || '.example.com:8080', 100 from upstreams u, generate_series(1, 5) t;
       insert into services (id, environment_id, name, protocol, host, port, path) select gen_random_uuid(), e.id, 'svc-' || s, 'http', 'svc-' || s || '.example.com', 80, '/v1' from environments e, generate_series(1, 50) s;
       insert into routes (id, environment_id, service_id, name, paths, hosts, strip_path) select gen_random_uuid(), s.environment_id, s.id, s.name || '-' || r, array['/' || s.name || '/' || r], null, true from services s, generate_series(1, 2) r;
       insert into consumers (id, environment_id, username, custom_id, acl_groups) select gen_random_uuid(), e.id, 'user-' || c, 'cid-' || c, '{}' from environments e, generate_series(1, 50) c;
       insert into plugins (id, environment_id, name, route_id, config) select gen_random_uuid(), r.environment_id, p, r.id, '{}' from routes r, unnest(array['cors', 'correlation-id']) p;`.replaceAll("$1::int", String(Math.trunc(scale))),
    );
    const [rows] = await query(url, `select (select count(*) from environments) + (select count(*) from upstreams) + (select count(*) from targets) + (select count(*) from services) + (select count(*) from routes) + (select count(*) from consumers) + (select count(*) from plugins) as n`);
    const started = performance.now();
    await runMigrations(url);
    const ms = Math.round(performance.now() - started);
    const line = `N1 migration: ${rows.n} rows in ${scale} environments migrated in ${ms} ms`;
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
    expect(await query(url, `select count(*)::int as n from workspaces where slug is null`)).toEqual([{ n: 0 }]);
    expect(await query(url, `select count(*)::int as n from routes where path_compatibility <> 'legacy-preserved'`)).toEqual([{ n: 0 }]);
    // Generous: it only catches a migration that went from seconds to an outage (rows scale linearly).
    expect(ms).toBeLessThan(300_000);
  });
});
