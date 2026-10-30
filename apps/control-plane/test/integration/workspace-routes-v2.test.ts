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
  const draftState = async (workspaceId: string) => (await h.sql.query(`
    select to_jsonb(e) as environment,
      (select jsonb_agg(r order by r.id) from routes r where r.environment_id = e.id) as routes,
      (select jsonb_agg(s order by s.id) from services s where s.environment_id = e.id) as services,
      (select jsonb_agg(s order by s.version) from snapshots s where s.environment_id = e.id) as snapshots,
      (select jsonb_agg(a order by a.id) from audit_events a where a.environment_id = e.id) as audits
    from environments e where e.id = $1`, [workspaceId])).rows[0];
  beforeAll(async () => {
    h = await startHarness({ autoPublishPollMs: 0 });
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

  it("refuses replacing a route with another workspace's service without changing the draft or auditing", async () => {
    const created = await v2(h.api, "POST", `/workspaces/${a}/routes`, { name: uniq("r"), serviceId: svcA, paths: ["/original"] });
    expect(created.status).toBe(201);
    const before = await draftState(a);
    const foreignBefore = await draftState(b);
    const res = await v2(h.api, "PUT", `/workspaces/${a}/routes/${created.body.id}`, { name: uniq("changed"), serviceId: svcB, paths: ["/changed"], stripPath: true });
    expect([res.status, res.body.errors?.[0]?.path], JSON.stringify(res.body)).toEqual([422, "serviceId"]);
    expect(await draftState(a)).toEqual(before);
    expect(await draftState(b)).toEqual(foreignBefore);
  });

  it("refuses replacing a route in an auto-publish environment without changing the draft or auditing", async () => {
    const env = (await h.api("POST", "/environments", { name: uniq("auto-put") })).body;
    const svc = await h.api("POST", `/environments/${env.id}/services`, { name: "svc", protocol: "http", host: "auto.example.com", port: 80 });
    expect(svc.status).toBe(201);
    const route = await v2(h.api, "POST", `/workspaces/${env.id}/routes`, { name: uniq("r"), serviceId: svc.body.id, paths: ["/original"] });
    expect(route.status).toBe(201);
    expect((await h.api("PATCH", `/environments/${env.id}`, { name: env.name, publishMode: "auto" })).status).toBe(200);
    const before = await draftState(env.id);
    const res = await v2(h.api, "PUT", `/workspaces/${env.id}/routes/${route.body.id}`, { name: uniq("changed"), serviceId: svc.body.id, paths: ["/changed"], stripPath: true });
    expect([res.status, res.body.code], JSON.stringify(res.body)).toEqual([409, "auto-publish"]);
    expect(await draftState(env.id)).toEqual(before);
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
  });

  it.each(["POST", "PUT"])("keeps routes and audits consistent when v2 %s races a service delete", async (method) => {
    for (let round = 0; round < 6; round++) {
      const ws = (await h.api("POST", "/environments", { name: uniq("ws-delete") })).body.id as string;
      const svc = await h.api("POST", `/environments/${ws}/services`, { name: "target", protocol: "http", host: "target.example.com", port: 80 });
      expect(svc.status).toBe(201);
      // Rebind an existing route to the contested service: the delete can win even for PUT.
      let routeId: string | undefined;
      if (method === "PUT") {
        const source = await h.api("POST", `/environments/${ws}/services`, { name: "source", protocol: "http", host: "source.example.com", port: 80 });
        expect(source.status).toBe(201);
        const route = await v2(h.api, "POST", `/workspaces/${ws}/routes`, { name: uniq("original"), serviceId: source.body.id, paths: ["/original"] });
        expect(route.status).toBe(201);
        routeId = route.body.id as string;
      }
      const before = (await h.sql.query("select * from routes where id = $1", [routeId])).rows;
      const auditIds = (await h.sql.query<{ id: string }>("select id from audit_events where environment_id = $1", [ws])).rows.map((r) => r.id);
      const body = { name: uniq("contested"), serviceId: svc.body.id as string, paths: ["/changed"] };
      const write = () => v2(h.api, method, `/workspaces/${ws}/routes${routeId ? `/${routeId}` : ""}`, body);
      const remove = () => round % 2 === 0
        ? v2(h.api, "DELETE", `/workspaces/${ws}/services/${svc.body.id}`)
        : h.api("DELETE", `/environments/${ws}/services/${svc.body.id}`);
      const [written, deleted] = round % 3 === 0
        ? await Promise.all([write(), remove()])
        : await Promise.all([remove(), write()]).then(([d, w]) => [w, d] as const);
      for (const res of [written, deleted]) expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
      const success = written.status === (method === "POST" ? 201 : 200);
      expect([method === "POST" ? 201 : 200, 404, 422], JSON.stringify(written.body)).toContain(written.status);
      expect([204, 409], JSON.stringify(deleted.body)).toContain(deleted.status);
      expect((await h.sql.query(`select r.id from routes r left join services s
        on s.id = r.service_id and s.environment_id = r.environment_id
        where r.environment_id = $1 and s.id is null`, [ws])).rows).toEqual([]);
      const remaining = (await h.sql.query("select id from services where id = $1", [svc.body.id])).rows;
      const stored = (await h.sql.query("select * from routes where environment_id = $1", [ws])).rows;
      if (success) {
        expect(deleted.status).toBe(409);
        expect(deleted.body.detail).toMatch(/route|referenced/);
        expect(remaining).toEqual([{ id: svc.body.id }]);
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({ id: written.body.id, name: body.name, service_id: svc.body.id, paths: body.paths, strip_path: false, path_compatibility: "workspace-default" });
      } else {
        expect(deleted.status).toBe(204);
        expect(remaining).toEqual([]);
        expect(stored).toEqual(before);
        if (written.status === 422) expect(written.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: "serviceId" })]));
      }
      const events = (await h.sql.query(`select action, entity_id from audit_events
        where environment_id = $1 and id <> all($2::uuid[])`, [ws, auditIds])).rows;
      const expected = [];
      if (success) expected.push({ action: method === "POST" ? "route.create" : "route.update", entity_id: written.body.id });
      if (deleted.status === 204) expected.push({ action: "service.delete", entity_id: svc.body.id });
      expect(events).toHaveLength(expected.length);
      expect(events).toEqual(expect.arrayContaining(expected));
    }
  });

  it("keeps the final draft consistent when v2 writes race a v1 edit and workspace archival", async () => {
    for (let round = 0; round < 6; round++) {
      const ws = (await h.api("POST", "/environments", { name: uniq("ws-race") })).body.id as string;
      const svc = (await h.api("POST", `/environments/${ws}/services`, { name: "svc", protocol: "http", host: "r.example.com", port: 80 })).body.id as string;
      const initial = await v2(h.api, "POST", `/workspaces/${ws}/routes`, { name: uniq("r"), serviceId: svc, paths: ["/a"] });
      expect(initial.status).toBe(201);
      const r = initial.body;
      const createName = uniq("r");
      const [v2Edit, v1Edit, created, archived] = await Promise.all([
        v2(h.api, "PUT", `/workspaces/${ws}/routes/${r.id}`, { name: r.name, serviceId: svc, paths: ["/b"] }),
        h.api("PUT", `/environments/${ws}/routes/${r.id}`, { name: r.name, serviceId: svc, paths: ["/c"], stripPath: false }),
        v2(h.api, "POST", `/workspaces/${ws}/routes`, { name: createName, serviceId: svc, paths: ["/d"] }),
        v2(h.api, "POST", `/workspaces/${ws}/archive`),
      ]);
      expect(archived.status, JSON.stringify(archived.body)).toBe(204);
      expect((await h.sql.query("select status from workspaces where id = $1", [ws])).rows).toEqual([{ status: "archived" }]);
      for (const [res, status] of [[v2Edit, 200], [v1Edit, 200], [created, 201]] as const) {
        expect([status, 409], JSON.stringify(res.body)).toContain(res.status);
        if (res.status === 409) expect(res.body.code).toBe("workspace-archived");
      }
      const stored = (await h.sql.query("select id, name, service_id, paths, strip_path, path_compatibility from routes where environment_id = $1", [ws])).rows;
      const edits = [v2Edit, v1Edit].filter((res) => res.status === 200);
      const final = stored.find((row) => row.id === r.id);
      expect(final).toMatchObject({ name: r.name, service_id: svc, strip_path: false, path_compatibility: "workspace-default" });
      expect(edits.length ? edits.map((res) => res.body.paths) : [["/a"]]).toContainEqual(final?.paths);
      expect(stored).toHaveLength(1 + Number(created.status === 201));
      if (created.status === 201) expect(stored).toContainEqual({ id: created.body.id, name: createName, service_id: svc, paths: ["/d"], strip_path: false, path_compatibility: "workspace-default" });
      const events = (await h.sql.query("select action, entity_id, after from audit_events where environment_id = $1", [ws])).rows;
      expect(events.filter((e) => e.action === "workspace.archive")).toHaveLength(1);
      expect(events.filter((e) => e.action === "route.update")).toHaveLength(edits.length);
      for (const [res, path] of [[v2Edit, "/b"], [v1Edit, "/c"]] as const) {
        expect(events.filter((e) => e.action === "route.update" && e.entity_id === r.id && e.after.paths[0] === path)).toHaveLength(Number(res.status === 200));
      }
      expect(events.filter((e) => e.action === "route.create")).toHaveLength(1 + Number(created.status === 201));
      const frozen = await draftState(ws);
      for (const res of await Promise.all([
        v2(h.api, "PUT", `/workspaces/${ws}/routes/${r.id}`, { name: r.name, serviceId: svc, paths: ["/late-v2"] }),
        h.api("PUT", `/environments/${ws}/routes/${r.id}`, { name: r.name, serviceId: svc, paths: ["/late-v1"], stripPath: false }),
        v2(h.api, "POST", `/workspaces/${ws}/routes`, { name: uniq("late"), serviceId: svc, paths: ["/late"] }),
      ])) expect([res.status, res.body.code]).toEqual([409, "workspace-archived"]);
      expect(await draftState(ws)).toEqual(frozen);
    }
  });

  it("needs gateway.write in the workspace", async () => {
    const viewer = await h.as("viewer");
    expect((await v2(viewer.api, "POST", `/workspaces/${a}/routes`, { name: uniq("r"), serviceId: svcA, paths: ["/v"] })).status).toBe(403);
  });
});
