import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractsV2 } from "../../src/common/contract.js";
import { type ApiResponse, startHarness, uniq, type Harness } from "./harness.js";

// N1-C2: routes that existed before N1 (and those v1 creates) stay legacy-preserved — same strip_path, same traffic —
// until an explicit, per-route, audited conversion to the workspace default (decision D1).
describe("legacy routes and their conversion to the workspace default", () => {
  let h: Harness;
  let v2: (client: Harness["api"], method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<ApiResponse>;
  let env: string;
  let slug: string;
  let routes: Record<string, string>;
  let svc: string;
  const validDiff = contractsV2.validator("RoutePathDiff");

  beforeAll(async () => {
    h = await startHarness();
    v2 = (client, method, path, body, headers) => client(method, `/../v2${path}`, body, headers);
    env = (await h.api("POST", "/environments", { name: uniq("legacy") })).body.id;
    slug = (await h.sql.query(`select slug from workspaces where id = $1`, [env])).rows[0].slug;
    svc = (await h.api("POST", `/environments/${env}/services`, { name: "orders", protocol: "http", host: "orders.example.com", port: 80, path: "/v1" })).body.id;
    routes = {};
    for (const [name, body] of [
      ["stripped", { paths: ["/orders"], stripPath: true }],
      ["full", { paths: ["/keep"], stripPath: false }],
      ["host-only", { hosts: ["orders.example.com"] }],
    ] as const) {
      routes[name] = (await h.api("POST", `/environments/${env}/routes`, { name, serviceId: svc, ...body })).body.id;
    }
  });
  afterAll(async () => {
    await h?.close();
  });

  const path = (route: string) => `/workspaces/${env}/routes/${route}/path-compatibility`;
  const classification = async (route: string) => (await h.sql.query(`select path_compatibility as c, strip_path as s from routes where id = $1`, [route])).rows[0];
  const draftHash = async () => (await h.api("GET", `/environments/${env}/publish-preview`)).body.draftHash as string;

  it("keeps every route v1 created legacy-preserved", async () => {
    for (const route of Object.values(routes)) expect((await classification(route)).c).toBe("legacy-preserved");
  });

  it("shows in a dry run what the upstream receives before and after, changing nothing", async () => {
    const before = await draftHash();
    const stripped = await v2(h.api, "POST", path(routes.stripped!), { dryRun: true });
    expect(stripped.status, JSON.stringify(stripped.body)).toBe(200);
    expect(validDiff(stripped.body), JSON.stringify(validDiff.errors)).toBe(true);
    expect(stripped.body).toMatchObject({
      routeId: routes.stripped,
      pathCompatibility: "legacy-preserved",
      paths: [{ publicPath: `/${slug}/orders`, upstreamBefore: "/orders -> /v1; /orders/{rest} -> /v1/{rest}", upstreamAfter: `/${slug}/orders -> /v1/${slug}/orders; /${slug}/orders/{rest} -> /v1/${slug}/orders/{rest}` }],
    });
    const full = await v2(h.api, "POST", path(routes.full!), { dryRun: true });
    expect(full.body.paths).toEqual([{ publicPath: `/${slug}/keep`, upstreamBefore: "/keep -> /v1/keep; /keep/{rest} -> /v1/keep/{rest}", upstreamAfter: `/${slug}/keep -> /v1/${slug}/keep; /${slug}/keep/{rest} -> /v1/${slug}/keep/{rest}` }]);
    expect(await draftHash()).toBe(before);
    expect(await classification(routes.stripped!)).toEqual({ c: "legacy-preserved", s: true });
  });

  it("refuses the conversion until the workspace composition (N2), changing nothing: today's traffic stays", async () => {
    const dry = await v2(h.api, "POST", path(routes.stripped!), { dryRun: true });
    expect((await v2(h.api, "POST", path(routes.stripped!), { dryRun: false })).status).toBe(422);
    expect((await v2(h.api, "POST", path(routes.stripped!), { dryRun: false, expectedDiffDigest: `sha256:${"0".repeat(64)}` })).status).toBe(409);
    const before = await draftHash();
    const refused = await v2(h.api, "POST", path(routes.stripped!), { dryRun: false, expectedDiffDigest: dry.body.diffDigest });
    expect(refused.status).toBe(409);
    expect(refused.body.detail).toMatch(/workspace composition/);
    expect(await classification(routes.stripped!)).toEqual({ c: "legacy-preserved", s: true });
    expect(await draftHash()).toBe(before);
    expect((await h.sql.query(`select count(*)::int as n from audit_events where action like 'route.path_compatibility%'`)).rows[0].n).toBe(0);
  });

  it("invalidates a dry run when anything its paths depend on changes, the service's path included", async () => {
    const dry = await v2(h.api, "POST", path(routes.full!), { dryRun: true });
    const service = (await h.api("GET", `/environments/${env}/services/${svc}`)).body;
    const { id: _i, createdAt: _c, updatedAt: _u, ...fields } = service;
    expect((await h.api("PUT", `/environments/${env}/services/${svc}`, { ...fields, path: "/v2" })).status).toBe(200);
    const again = await v2(h.api, "POST", path(routes.full!), { dryRun: true });
    expect(again.body.diffDigest).not.toBe(dry.body.diffDigest);
    expect(again.body.paths[0].upstreamBefore).toBe("/keep -> /v2/keep; /keep/{rest} -> /v2/keep/{rest}");
    const stale = await v2(h.api, "POST", path(routes.full!), { dryRun: false, expectedDiffDigest: dry.body.diffDigest });
    expect(stale.status).toBe(409);
    expect(stale.body.detail).toMatch(/changed since the dry run/);
  });

  it("refuses a route without a path: it cannot take the prefix", async () => {
    const dry = await v2(h.api, "POST", path(routes["host-only"]!), { dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.paths).toEqual([]);
    const res = await v2(h.api, "POST", path(routes["host-only"]!), { dryRun: false, expectedDiffDigest: dry.body.diffDigest });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: { path: string }) => e.path)).toEqual(["paths"]);
  });

  it("is a session decision of a workspace admin, scoped to the workspace", async () => {
    const editor = await h.as("editor");
    expect((await v2(editor.api, "POST", path(routes.full!), { dryRun: true })).status).toBe(403);
    const token = (await h.api("POST", "/users/me/tokens", { name: uniq("t"), role: "admin", expiresInDays: 1 })).body.token as string;
    expect((await v2(h.anonymous, "POST", path(routes.full!), { dryRun: true }, { authorization: `Bearer ${token}` })).status).toBe(401);
    const hidden = await h.as("viewer");
    await h.api("PUT", `/users/${hidden.id}/environment-roles`, { items: [{ environmentId: env, role: "none" }] });
    expect((await v2(hidden.api, "POST", path(routes.full!), { dryRun: true })).status).toBe(404);
    const other = (await h.api("POST", "/environments", { name: uniq("other") })).body.id;
    expect((await v2(h.api, "POST", `/workspaces/${other}/routes/${routes.full}/path-compatibility`, { dryRun: true })).status).toBe(404);
  });
});
