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
  const validDiff = contractsV2.validator("RoutePathDiff");

  beforeAll(async () => {
    h = await startHarness();
    v2 = (client, method, path, body, headers) => client(method, `/../v2${path}`, body, headers);
    env = (await h.api("POST", "/environments", { name: uniq("legacy") })).body.id;
    slug = (await h.sql.query(`select slug from workspaces where id = $1`, [env])).rows[0].slug;
    const svc = (await h.api("POST", `/environments/${env}/services`, { name: "orders", protocol: "http", host: "orders.example.com", port: 80, path: "/v1" })).body.id;
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
    expect(stripped.body).toMatchObject({ routeId: routes.stripped, pathCompatibility: "legacy-preserved", paths: [{ publicPath: `/${slug}/orders`, upstreamBefore: "/v1", upstreamAfter: `/v1/${slug}/orders` }] });
    const full = await v2(h.api, "POST", path(routes.full!), { dryRun: true });
    expect(full.body.paths).toEqual([{ publicPath: `/${slug}/keep`, upstreamBefore: "/v1/keep", upstreamAfter: `/v1/${slug}/keep` }]);
    expect(await draftHash()).toBe(before);
    expect(await classification(routes.stripped!)).toEqual({ c: "legacy-preserved", s: true });
  });

  it("converts only with the digest of the dry run, in the draft, audited, once", async () => {
    const dry = await v2(h.api, "POST", path(routes.stripped!), { dryRun: true });
    expect((await v2(h.api, "POST", path(routes.stripped!), { dryRun: false })).status).toBe(422);
    expect((await v2(h.api, "POST", path(routes.stripped!), { dryRun: false, expectedDiffDigest: `sha256:${"0".repeat(64)}` })).status).toBe(409);
    const before = await draftHash();
    const converted = await v2(h.api, "POST", path(routes.stripped!), { dryRun: false, expectedDiffDigest: dry.body.diffDigest });
    expect(converted.status, JSON.stringify(converted.body)).toBe(204);
    expect(await classification(routes.stripped!)).toEqual({ c: "workspace-default", s: false });
    // A draft change only: nothing is published by the conversion.
    expect(await draftHash()).not.toBe(before);
    expect((await h.api("GET", `/environments/${env}`)).body.hasUnpublishedChanges).toBe(true);
    const events = (await h.sql.query(`select after from audit_events where action = 'route.path_compatibility.convert' and entity_id = $1`, [routes.stripped])).rows;
    expect(events).toHaveLength(1);
    expect(events[0].after).toMatchObject({ pathCompatibility: "workspace-default", stripPath: false, diffDigest: dry.body.diffDigest });
    expect((await v2(h.api, "POST", path(routes.stripped!), { dryRun: false, expectedDiffDigest: dry.body.diffDigest })).status).toBe(409);
    // The other routes are untouched: never in bulk.
    expect(await classification(routes.full!)).toEqual({ c: "legacy-preserved", s: false });
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
