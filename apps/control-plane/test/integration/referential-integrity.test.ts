import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

  beforeAll(async () => {
    h = await startHarness();
    a = await fixture();
    b = await fixture();
  });

  afterAll(async () => {
    await h?.close();
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

  it.each(crossWrites.slice(0, 9))("would accept that write without %s (negative control)", async (constraint, text, values) => {
    const table = text.match(/^insert into (\w+)/)![1]!;
    const client = await h.sql.connect();
    try {
      await client.query("begin");
      await client.query(`alter table ${table} drop constraint ${constraint}`);
      await expect(client.query(text, values(a, b))).resolves.toBeDefined();
    } finally {
      await client.query("rollback");
      client.release();
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
