import { ADMIN_URL, integrationDatabaseName, createIntegrationDatabase, dropIntegrationDatabase } from "./databases.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { startHarness, uniq, type Harness } from "./harness.js";

// N1-X2: every entity belongs to exactly one workspace, and nothing points across workspaces — refused by the service
// (422/404, as before) and by the database itself (composite foreign keys on (environment_id, id)).
interface Fixture {
  env: string;
  service: string;
  route: string;
  upstream: string;
  target: string;
  consumer: string;
  keyAuth: string;
  certificate: string;
  plugin: string;
}

describe("referential integrity between workspaces", () => {
  let h: Harness;
  let a: Fixture;
  let b: Fixture;

  const ok = <T>(res: { status: number; body: T }, status = 201): T => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body;
  };

  async function fixture(): Promise<Fixture> {
    const env = ok(await h.api("POST", "/environments", { name: uniq("ri") })).id as string;
    const upstream = ok(await h.api("POST", `/environments/${env}/upstreams`, { name: "pool" })).id;
    const target = ok(await h.api("POST", `/environments/${env}/upstreams/${upstream}/targets`, { target: "backend.example.com:8080" })).id;
    const service = ok(await h.api("POST", `/environments/${env}/services`, { name: "orders", protocol: "http", host: "pool", port: 80 })).id;
    const route = ok(await h.api("POST", `/environments/${env}/routes`, { name: "orders", serviceId: service, paths: ["/orders"] })).id;
    // The same logical consumer in both workspaces (decision H-5).
    const consumer = ok(await h.api("POST", `/environments/${env}/consumers`, { username: "app-sky" })).id;
    const keyAuth = ok(await h.api("POST", `/environments/${env}/consumers/${consumer}/key-auth`, {})).id;
    const plugin = ok(await h.api("POST", `/environments/${env}/plugins`, { name: "cors", config: { origins: ["https://example.com"] }, scope: { routeId: route } })).id;
    // A certificate row straight in the database: the cross-workspace SNI below needs only its identity.
    const [cert] = (
      await h.sql.query(
        `insert into certificates (environment_id, cert, key, subject, issuer, not_before, not_after, fingerprint_sha256)
         values ($1, 'x', 'x', 'CN=x', 'CN=x', now(), now() + interval '1 day', 'f') returning id`,
        [env],
      )
    ).rows;
    return { env, service, route, upstream, target, consumer, keyAuth, certificate: cert.id, plugin };
  }

  // The private database of the negative controls: migrated, with one row of each entity in two workspaces.
  let privateDb: string;
  let pa: Fixture;
  let pb: Fixture;
  const privateName = integrationDatabaseName("ri");
  async function privateFixture(n: number): Promise<Fixture> {
    const id = (k: number) => `00000000-0000-4000-8000-${String(n * 100 + k).padStart(12, "0")}`;
    const f: Fixture = { env: id(1), service: id(2), route: id(3), upstream: id(4), target: id(5), consumer: id(6), keyAuth: id(7), certificate: id(8), plugin: id(9) };
    const c = new pg.Client({ connectionString: privateDb });
    await c.connect();
    try {
      await c.query(`insert into environments (id, name) values ($1, $2)`, [f.env, `p${n}`]);
      await c.query(`insert into services (id, environment_id, name, protocol, host, port) values ($1, $2, 'svc', 'http', 'a.example.com', 80)`, [f.service, f.env]);
      await c.query(`insert into routes (id, environment_id, service_id, name, paths) values ($1, $2, $3, 'r', '{/r}')`, [f.route, f.env, f.service]);
      await c.query(`insert into upstreams (id, environment_id, name, healthchecks) values ($1, $2, 'pool', '{"active":null,"passive":null}')`, [f.upstream, f.env]);
      await c.query(`insert into consumers (id, environment_id, username) values ($1, $2, 'app-sky')`, [f.consumer, f.env]);
      await c.query(`insert into certificates (id, environment_id, cert, key, subject, issuer, not_before, not_after, fingerprint_sha256) values ($1, $2, 'c', 'k', 's', 'i', now(), now(), 'f')`, [f.certificate, f.env]);
    } finally {
      await c.end();
    }
    return f;
  }

  beforeAll(async () => {
    h = await startHarness();
    a = await fixture();
    b = await fixture();
    await createIntegrationDatabase(privateName);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${privateName}`;
    privateDb = url.toString();
    await runMigrations(privateDb);
    pa = await privateFixture(1);
    pb = await privateFixture(2);
  });

  afterAll(async () => {
    await h?.close();
    await dropIntegrationDatabase(privateName);
  });

  it("refuses through the API a reference to an entity of another workspace", async () => {
    const route = await h.api("POST", `/environments/${a.env}/routes`, { name: "cross", serviceId: b.service, paths: ["/x"] });
    expect(route.status).toBe(422);
    expect(route.body.errors).toEqual([{ path: "serviceId", message: "unknown service in this environment" }]);
    for (const [key, value] of [["serviceId", b.service], ["routeId", b.route], ["consumerId", b.consumer]] as const) {
      const plugin = await h.api("POST", `/environments/${a.env}/plugins`, { name: "cors", config: { origins: ["*"] }, scope: { [key]: value } });
      expect(plugin.status, key).toBe(422);
      expect(plugin.body.errors.map((e: { path: string }) => e.path)).toEqual([`scope.${key}`]);
    }
    expect((await h.api("POST", `/environments/${a.env}/consumers/${b.consumer}/key-auth`, {})).status).toBe(404);
    expect((await h.api("POST", `/environments/${a.env}/upstreams/${b.upstream}/targets`, { target: "x.example.com:80" })).status).toBe(404);
    expect((await h.api("GET", `/environments/${a.env}/routes/${b.route}`)).status).toBe(404);
    // Every credential type under another workspace's consumer, and every replacement pointing across.
    expect((await h.api("POST", `/environments/${a.env}/consumers/${b.consumer}/jwt`, {})).status).toBe(404);
    expect((await h.api("POST", `/environments/${a.env}/consumers/${b.consumer}/basic-auth`, { username: uniq("u"), password: "a-long-password" })).status).toBe(404);
    expect((await h.api("PUT", `/environments/${a.env}/consumers/${b.consumer}/acl-groups`, { groups: ["x"] })).status).toBe(404);
    const replacedRoute = await h.api("PUT", `/environments/${a.env}/routes/${a.route}`, { name: "orders", serviceId: b.service, paths: ["/orders"] });
    expect(replacedRoute.status).toBe(422);
    expect(replacedRoute.body.errors).toEqual([{ path: "serviceId", message: "unknown service in this environment" }]);
    const replacedPlugin = await h.api("PUT", `/environments/${a.env}/plugins/${a.plugin}`, { name: "cors", config: { origins: ["*"] }, scope: { routeId: b.route } });
    expect(replacedPlugin.status).toBe(422);
    expect(replacedPlugin.body.errors.map((e: { path: string }) => e.path)).toEqual(["scope.routeId"]);
    // Nothing changed in either workspace.
    expect((await h.api("GET", `/environments/${a.env}/routes/${a.route}`)).body.serviceId).toBe(a.service);
  });

  it("resolves anonymous only to a consumer of the plugin's own workspace (by id or username)", async () => {
    const onlyB = (await h.api("POST", `/environments/${b.env}/consumers`, { username: uniq("only-b") })).body;
    const plugin = (config: Record<string, unknown>) => h.api("POST", `/environments/${a.env}/plugins`, { name: "key-auth", config: { key_names: ["apikey"], ...config }, scope: { routeId: a.route } });
    for (const anonymous of [b.consumer, b.consumer.toUpperCase(), onlyB.username, "nobody"]) {
      const refused = await plugin({ anonymous });
      expect(refused.status, anonymous).toBe(422);
      expect(refused.body.errors, anonymous).toEqual([{ path: "config.anonymous", message: "unknown consumer in this environment" }]);
    }
    // "app-sky" exists in both workspaces: in A it is A's own consumer (decision H-5).
    const byName = await plugin({ anonymous: "app-sky" });
    expect(byName.status, JSON.stringify(byName.body)).toBe(201);
    const byId = await h.api("PUT", `/environments/${a.env}/plugins/${byName.body.id}`, { name: "key-auth", config: { key_names: ["apikey"], anonymous: a.consumer.toUpperCase() }, scope: { routeId: a.route } });
    expect(byId.status, JSON.stringify(byId.body)).toBe(200);
    // A consumer used as anonymous can be neither deleted nor renamed; another consumer can.
    expect((await h.api("DELETE", `/environments/${a.env}/consumers/${a.consumer}`)).status).toBe(409);
    await h.api("PUT", `/environments/${a.env}/plugins/${byName.body.id}`, { name: "key-auth", config: { key_names: ["apikey"], anonymous: "app-sky" }, scope: { routeId: a.route } });
    expect((await h.api("PUT", `/environments/${a.env}/consumers/${a.consumer}`, { username: "app-sky-renamed" })).status).toBe(409);
    expect((await h.api("PUT", `/environments/${a.env}/consumers/${a.consumer}`, { username: "app-sky", customId: "sky-x" })).status).toBe(200);
    expect((await h.api("PUT", `/environments/${b.env}/consumers/${b.consumer}`, { username: "app-sky-renamed" })).status).toBe(200);
    await h.api("PUT", `/environments/${b.env}/consumers/${b.consumer}`, { username: "app-sky" });
    expect((await h.api("DELETE", `/environments/${a.env}/plugins/${byName.body.id}`)).status).toBe(204);
  });

  it("refuses anonymous across workspaces in the database too", async () => {
    await expect(h.sql.query(`insert into plugins (environment_id, name, config) values ($1, 'key-auth', jsonb_build_object('anonymous', $2::text))`, [a.env, b.consumer])).rejects.toThrow(/plugins_anonymous_consumer|anonymous/);
    const [{ id: pid }] = (await h.sql.query(`insert into plugins (environment_id, name, config) values ($1, 'basic-auth', jsonb_build_object('anonymous', $2::text)) returning id`, [a.env, a.consumer])).rows;
    await expect(h.sql.query(`update plugins set config = jsonb_build_object('anonymous', $2::text) where id = $1`, [pid, b.consumer])).rejects.toThrow(/anonymous/);
    await expect(h.sql.query(`delete from consumers where id = $1`, [a.consumer])).rejects.toThrow(/anonymous/);
    // Named by id: renaming the consumer keeps the reference, leaving the workspace does not.
    await h.sql.query(`update consumers set username = 'renamed-by-sql' where id = $1`, [a.consumer]);
    await h.sql.query(`update consumers set username = 'app-sky' where id = $1`, [a.consumer]);
    await h.sql.query(`delete from plugins where id = $1`, [pid]);
    // Named by username, in a route plugin (no consumer scope): renaming or moving the consumer is refused.
    const loose = (await h.api("POST", `/environments/${a.env}/consumers`, { username: uniq("loose") })).body;
    const [{ id: rid }] = (await h.sql.query(`insert into plugins (environment_id, name, route_id, config) values ($1, 'basic-auth', $2, jsonb_build_object('anonymous', $3::text)) returning id`, [a.env, a.route, loose.username])).rows;
    await expect(h.sql.query(`update consumers set username = 'renamed-by-sql' where id = $1`, [loose.id])).rejects.toThrow(/anonymous/);
    await expect(h.sql.query(`update consumers set environment_id = $2 where id = $1`, [loose.id, b.env])).rejects.toThrow(/anonymous/);
    await expect(h.sql.query(`update consumers set custom_id = 'other' where id = $1 returning id`, [loose.id])).resolves.toBeDefined();
    await h.sql.query(`delete from plugins where id = $1`, [rid]);
    // Negative control, on the private database: without the trigger the same write goes through.
    const client = new pg.Client({ connectionString: privateDb });
    await client.connect();
    try {
      const write = `insert into plugins (environment_id, name, config) values ($1, 'key-auth', jsonb_build_object('anonymous', $2::text))`;
      await expect(client.query(write, [pa.env, pb.consumer])).rejects.toThrow(/anonymous/);
      await client.query("begin");
      await client.query("drop trigger plugins_anonymous on plugins");
      await expect(client.query(write, [pa.env, pb.consumer])).resolves.toBeDefined();
    } finally {
      await client.query("rollback");
      await client.end();
    }
  });

  it("refuses an import, and a rollback, whose plugin falls back to a consumer it does not hold", async () => {
    const c = await fixture();
    const e = `/environments/${c.env}`;
    // The fixture's certificate is a placeholder row that does not compile; this workspace publishes.
    await h.sql.query(`delete from certificates where environment_id = $1`, [c.env]);
    const doc = (await h.api("GET", `${e}/export?format=json`)).body;
    doc.plugins.push({ name: "key-auth", config: { key_names: ["k"], anonymous: b.consumer }, scope: { route: "orders" } });
    const index = doc.plugins.length - 1;
    for (const dryRun of [true, false]) {
      const res = await h.api("POST", `${e}/import`, { mode: "merge", document: doc, dryRun });
      expect(res.status, `dryRun ${dryRun}`).toBe(dryRun ? 200 : 422);
      expect(res.body.errors, `dryRun ${dryRun}`).toContainEqual({ path: `document.plugins.${index}.config.anonymous`, message: "unknown consumer in the resulting draft" });
    }
    // A version published before the rule, with a dangling anonymous, is not restored.
    const first = await h.api("POST", `${e}/snapshots`, {});
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    // Written as before the rule: triggers off for this session only (no table lock).
    const client = await h.sql.connect();
    try {
      await client.query("set session_replication_role = replica");
      await client.query(`insert into plugins (environment_id, name, route_id, config) values ($1, 'key-auth', $2, jsonb_build_object('key_names', jsonb_build_array('k'), 'anonymous', $3::text))`, [c.env, c.route, b.consumer]);
    } finally {
      await client.query("set session_replication_role = origin");
      client.release();
    }
    await h.sql.query(`update environments set has_unpublished_changes = true where id = $1`, [c.env]);
    const dangling = await h.api("POST", `${e}/snapshots`, {});
    expect(dangling.status, JSON.stringify(dangling.body)).toBe(201);
    await h.sql.query(`delete from plugins where environment_id = $1 and name = 'key-auth'`, [c.env]);
    const fixed = await h.api("POST", `${e}/snapshots`, {});
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(201);
    const rolled = await h.api("POST", `${e}/snapshots/2/rollback`);
    expect(rolled.status).toBe(409);
    expect(rolled.body.detail).toBe("A plugin of this configuration uses as anonymous a consumer it does not hold");
    expect((await h.sql.query(`select count(*)::int as n from plugins where environment_id = $1 and name = 'key-auth'`, [c.env])).rows[0].n).toBe(0);
    // Deleting the whole workspace still cascades through consumers used as anonymous.
    const kept = await h.api("POST", `${e}/plugins`, { name: "key-auth", config: { key_names: ["k"], anonymous: "app-sky" }, scope: { routeId: c.route } });
    expect(kept.status, JSON.stringify(kept.body)).toBe(201);
    expect((await h.sql.query(`select count(*)::int as n from plugins where id = $1 and config->>'anonymous' = 'app-sky'`, [kept.body.id])).rows[0].n).toBe(1);
    expect((await h.sql.query(`delete from environments where id = $1 returning id`, [c.env])).rows).toHaveLength(1);
    expect((await h.sql.query(`select count(*)::int as n from plugins where id = $1`, [kept.body.id])).rows[0].n).toBe(0);
  });

  // Each composite foreign key, written around the service as only a direct database write could.
  const crossWrites: [string, string, (x: Fixture, y: Fixture) => unknown[]][] = [
    ["routes_service_fk", `insert into routes (environment_id, service_id, name, paths) values ($1, $2, 'cross', '{/x}')`, (x, y) => [x.env, y.service]],
    ["targets_upstream_fk", `insert into targets (environment_id, upstream_id, target) values ($1, $2, 'y.example.com:80')`, (x, y) => [x.env, y.upstream]],
    ["keyauth_consumer_fk", `insert into keyauth_credentials (environment_id, consumer_id, key, key_hash) values ($1, $2, 'k', 'cross-hash')`, (x, y) => [x.env, y.consumer]],
    ["jwt_consumer_fk", `insert into jwt_credentials (environment_id, consumer_id, key, algorithm) values ($1, $2, 'cross-iss', 'HS256')`, (x, y) => [x.env, y.consumer]],
    ["basicauth_consumer_fk", `insert into basicauth_credentials (environment_id, consumer_id, username, password_hash) values ($1, $2, 'cross-user', 'h')`, (x, y) => [x.env, y.consumer]],
    ["certificate_snis_certificate_fk", `insert into certificate_snis (environment_id, certificate_id, name) values ($1, $2, 'cross.example.com')`, (x, y) => [x.env, y.certificate]],
    ["plugins_service_fk", `insert into plugins (environment_id, name, service_id, config) values ($1, 'cors', $2, '{}')`, (x, y) => [x.env, y.service]],
    ["plugins_route_fk", `insert into plugins (environment_id, name, route_id, config) values ($1, 'cors', $2, '{}')`, (x, y) => [x.env, y.route]],
    ["plugins_consumer_fk", `insert into plugins (environment_id, name, consumer_id, config) values ($1, 'cors', $2, '{}')`, (x, y) => [x.env, y.consumer]],
    // Moving an entity to another workspace (renamed, so only the foreign key can refuse it) strands what references it.
    ["routes_service_fk", `update services set environment_id = $2, name = name || '-moved' where id = $1`, (x, y) => [x.service, y.env]],
    ["plugins_route_fk", `update routes set environment_id = $2, name = name || '-moved' where id = $1`, (x, y) => [x.route, y.env]],
    ["keyauth_consumer_fk", `update consumers set environment_id = $2, username = username || '-moved' where id = $1`, (x, y) => [x.consumer, y.env]],
  ];

  it.each(crossWrites)("refuses in the database a reference across workspaces (%s)", async (constraint, text, values) => {
    await expect(h.sql.query(text, values(a, b))).rejects.toThrow(new RegExp(constraint));
  });

  // On a database of its own: dropping a constraint locks the table, and the other test files share theirs.
  it.each(crossWrites.slice(0, 9))("would accept that write without %s (negative control)", async (constraint, text, values) => {
    const table = text.match(/^insert into (\w+)/)![1]!;
    const client = new pg.Client({ connectionString: privateDb });
    await client.connect();
    try {
      await client.query("begin");
      await expect(client.query(text, values(pa, pb)), "refused with the constraint").rejects.toThrow(new RegExp(constraint));
      await client.query("rollback");
      await client.query("begin");
      await client.query(`alter table ${table} drop constraint ${constraint}`);
      await expect(client.query(text, values(pa, pb))).resolves.toBeDefined();
    } finally {
      await client.query("rollback");
      await client.end();
    }
  });

  it("accepts the same writes inside one workspace", async () => {
    const client = await h.sql.connect();
    try {
      await client.query("begin");
      for (const [, text, values] of crossWrites.slice(0, 9)) {
        // Another plugin name: the fixture's cors already holds the (name, scope) of the route.
        await expect(client.query(text.replace("'cors'", "'request-termination'"), values(a, a))).resolves.toBeDefined();
      }
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("keeps the delete rules: a service with routes is a 409, and a workspace goes away with everything it owns", async () => {
    expect((await h.api("DELETE", `/environments/${a.env}/services/${a.service}`)).status).toBe(409);
    const c = await fixture();
    expect((await h.api("DELETE", `/environments/${c.env}`)).status).toBe(204);
    for (const table of ["services", "routes", "upstreams", "targets", "consumers", "keyauth_credentials", "plugins", "certificates", "workspaces"]) {
      const column = table === "workspaces" ? "id" : "environment_id";
      expect((await h.sql.query(`select count(*)::int as n from ${table} where ${column} = $1`, [c.env])).rows[0].n, table).toBe(0);
    }
    // The other workspaces keep every row.
    expect((await h.sql.query(`select count(*)::int as n from routes where environment_id = any($1)`, [[a.env, b.env]])).rows[0].n).toBe(2);
  });
});
