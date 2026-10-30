import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiClient, type ApiResponse, startHarness, uniq, type Harness } from "./harness.js";

// WS-R2 (contract WS-R0): writing routes through /api/v2. A v2 route is workspace-default (full path to the upstream,
// stripPath false unless chosen), refers only to a service of its own workspace and to regex paths the composition
// accepts; a migrated legacy-preserved route keeps its classification and its stripPath (only an explicit conversion
// changes them). Edits the draft only.
const v2 = (client: ApiClient, method: string, path: string, body?: unknown): Promise<ApiResponse> => client(method, `/../v2${path}`, body);

describe("routes through /api/v2 (WS-R2)", () => {
  let h: Harness;
  let a: string;
  let b: string;
  let svcA: string;
  let svcB: string;
  beforeAll(async () => {
    h = await startHarness();
    a = (await h.api("POST", "/environments", { name: uniq("ws-a") })).body.id;
    b = (await h.api("POST", "/environments", { name: uniq("ws-b") })).body.id;
    svcA = (await h.api("POST", `/environments/${a}/services`, { name: "svc", protocol: "http", host: "a.example.com", port: 80 })).body.id;
    svcB = (await h.api("POST", `/environments/${b}/services`, { name: "svc", protocol: "http", host: "b.example.com", port: 80 })).body.id;
  });
  afterAll(async () => h?.close());

  it("creates a workspace-default route that forwards the full path by default, audited, publishing nothing", async () => {
    const snapshots = (await h.sql.query("select count(*)::int as n from snapshots where environment_id = $1", [a])).rows[0].n;
    const res = await v2(h.api, "POST", `/workspaces/${a}/routes`, { name: uniq("r"), serviceId: svcA, paths: ["/recarga"] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ serviceId: svcA, paths: ["/recarga"], stripPath: false, pathCompatibility: "workspace-default" });
    expect((await v2(h.api, "GET", `/workspaces/${a}/routes/${res.body.id}`)).body).toEqual(res.body);
    expect((await v2(h.api, "GET", `/workspaces/${b}/routes/${res.body.id}`)).status).toBe(404);
    expect((await h.sql.query("select count(*)::int as n from snapshots where environment_id = $1", [a])).rows[0].n).toBe(snapshots);
    expect((await h.sql.query("select count(*)::int as n from audit_events where action = 'route.create' and entity_id = $1", [res.body.id])).rows[0].n).toBe(1);
    // stripPath true is an explicit choice.
    expect((await v2(h.api, "POST", `/workspaces/${a}/routes`, { name: uniq("r"), serviceId: svcA, paths: ["/x"], stripPath: true })).body.stripPath).toBe(true);
  });

  it("refers only to a service of its own workspace and requires paths", async () => {
    const cross = await v2(h.api, "POST", `/workspaces/${a}/routes`, { name: uniq("r"), serviceId: svcB, paths: ["/x"] });
    expect([cross.status, cross.body.errors[0].path]).toEqual([422, "serviceId"]);
    expect((await v2(h.api, "POST", `/workspaces/${a}/routes`, { name: uniq("r"), serviceId: svcA })).status).toBe(422);
    expect((await v2(h.api, "POST", `/workspaces/${a}/routes`, { name: uniq("r"), serviceId: svcA, paths: [] })).status).toBe(422);
  });

  it("accepts a regex path only in the form the composition accepts", async () => {
    expect((await v2(h.api, "POST", `/workspaces/${a}/routes`, { name: uniq("r"), serviceId: svcA, paths: ["~/pedidos/[0-9]+$"] })).status).toBe(201);
    for (const bad of ["~(?:x)", "~/a|b", "~/a\\1", "~/[[:alpha:]]"]) {
      const res = await v2(h.api, "POST", `/workspaces/${a}/routes`, { name: uniq("r"), serviceId: svcA, paths: ["/ok", bad] });
      expect([res.status, res.body.errors?.[0]?.path], bad).toEqual([422, "paths.1"]);
    }
  });

  it("replaces a workspace-default route as written, and a legacy one without converting it", async () => {
    const route = (await v2(h.api, "POST", `/workspaces/${a}/routes`, { name: uniq("r"), serviceId: svcA, paths: ["/a"] })).body;
    const replaced = await v2(h.api, "PUT", `/workspaces/${a}/routes/${route.id}`, { name: route.name, serviceId: svcA, paths: ["/b"] });
    expect([replaced.status, replaced.body.id, replaced.body.paths, replaced.body.stripPath, replaced.body.pathCompatibility]).toEqual([200, route.id, ["/b"], false, "workspace-default"]);

    // v1 creates legacy-preserved routes, stripPath true by default.
    const legacy = (await h.api("POST", `/environments/${a}/routes`, { name: uniq("legacy"), serviceId: svcA, paths: ["/old"] })).body;
    const kept = await v2(h.api, "PUT", `/workspaces/${a}/routes/${legacy.id}`, { name: legacy.name, serviceId: svcA, paths: ["/old", "/older"] });
    expect([kept.status, kept.body.stripPath, kept.body.pathCompatibility], JSON.stringify(kept.body)).toEqual([200, true, "legacy-preserved"]);
    const converted = await v2(h.api, "PUT", `/workspaces/${a}/routes/${legacy.id}`, { name: legacy.name, serviceId: svcA, paths: ["/old"], stripPath: false });
    expect([converted.status, converted.body.code]).toEqual([409, "path-compatibility"]);
    expect((await v2(h.api, "GET", `/workspaces/${a}/routes/${legacy.id}`)).body).toMatchObject({ stripPath: true, pathCompatibility: "legacy-preserved", paths: ["/old", "/older"] });
    expect((await v2(h.api, "PUT", `/workspaces/${b}/routes/${legacy.id}`, { name: legacy.name, serviceId: svcB, paths: ["/x"] })).status).toBe(404);
  });

  it("checks a legacy route's regex paths too, and never writes through v2 where v1 auto-publishes", async () => {
    const legacy = (await h.api("POST", `/environments/${a}/routes`, { name: uniq("legacy"), serviceId: svcA, paths: ["/old"] })).body;
    const bad = await v2(h.api, "PUT", `/workspaces/${a}/routes/${legacy.id}`, { name: legacy.name, serviceId: svcA, paths: ["~/a|b"] });
    expect([bad.status, bad.body.errors?.[0]?.path]).toEqual([422, "paths.0"]);
    const auto = (await h.api("POST", "/environments", { name: uniq("auto"), publishMode: "auto" })).body.id as string;
    const svc = (await h.api("POST", `/environments/${auto}/services`, { name: "svc", protocol: "http", host: "c.example.com", port: 80 })).body.id as string;
    const refused = await v2(h.api, "POST", `/workspaces/${auto}/routes`, { name: uniq("r"), serviceId: svc, paths: ["/x"] });
    expect([refused.status, refused.body.code]).toEqual([409, "auto-publish"]);
    expect((await h.sql.query("select count(*)::int as n from routes where environment_id = $1", [auto])).rows[0].n).toBe(0);
  });

  it("never deadlocks: concurrent route writes in one workspace all answer, none with a 500", async () => {
    const routes = await Promise.all([1, 2, 3].map(async () => (await v2(h.api, "POST", `/workspaces/${a}/routes`, { name: uniq("c"), serviceId: svcA, paths: [`/${uniq("p")}`] })).body));
    const results = await Promise.all([
      ...routes.map((r) => v2(h.api, "PUT", `/workspaces/${a}/routes/${r.id}`, { name: r.name, serviceId: svcA, paths: [`/${uniq("q")}`] })),
      ...[1, 2, 3].map(() => v2(h.api, "POST", `/workspaces/${a}/routes`, { name: uniq("c"), serviceId: svcA, paths: [`/${uniq("p")}`] })),
    ]);
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    // With a v1 edit of the same route and an archive of the workspace in the same instant: never a 500.
    for (let round = 0; round < 6; round++) {
      const ws = (await h.api("POST", "/environments", { name: uniq("ws-race") })).body.id as string;
      const svc = (await h.api("POST", `/environments/${ws}/services`, { name: "svc", protocol: "http", host: "r.example.com", port: 80 })).body.id as string;
      const r = (await v2(h.api, "POST", `/workspaces/${ws}/routes`, { name: uniq("r"), serviceId: svc, paths: ["/a"] })).body;
      const raced = await Promise.all([
        v2(h.api, "PUT", `/workspaces/${ws}/routes/${r.id}`, { name: r.name, serviceId: svc, paths: ["/b"] }),
        h.api("PUT", `/environments/${ws}/routes/${r.id}`, { name: r.name, serviceId: svc, paths: ["/c"], stripPath: false }),
        v2(h.api, "POST", `/workspaces/${ws}/routes`, { name: uniq("r"), serviceId: svc, paths: ["/d"] }),
        v2(h.api, "POST", `/workspaces/${ws}/archive`),
      ]);
      for (const x of raced) expect(x.status, JSON.stringify(x.body)).toBeLessThan(500);
    }
  });

  it("needs gateway.write in the workspace", async () => {
    const viewer = await h.as("viewer");
    expect((await v2(viewer.api, "POST", `/workspaces/${a}/routes`, { name: uniq("r"), serviceId: svcA, paths: ["/v"] })).status).toBe(403);
  });
});
