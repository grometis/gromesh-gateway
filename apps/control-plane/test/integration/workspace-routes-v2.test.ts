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
  const routePayload = (body: Record<string, unknown>) => {
    const { pathCompatibility: _compatibility, ...payload } = body;
    return payload;
  };
  const eventsSince = async (ws: string, ids: string[]) => (await h.sql.query(`
    select action, entity_type, entity_id, before, after from audit_events
    where environment_id = $1 and id <> all($2::uuid[]) order by at, id`, [ws, ids])).rows;
  const auditIds = async (ws: string) => (await h.sql.query<{ id: string }>(
    "select id from audit_events where environment_id = $1", [ws])).rows.map((e) => e.id);

  // Observe the actual blocked backend and its blocker, rather than assuming a request reached a lock after a delay.
  const waitForLock = async (blockers: number[], queryPattern: string, exclude: number[] = []) => {
    const deadline = Date.now() + 5_000;
    do {
      const { rows } = await h.sql.query<{ pid: number }>(`
        select a.pid from pg_stat_activity a
        where a.datname = current_database() and a.wait_event_type = 'Lock'
          and pg_blocking_pids(a.pid) && $1::int[] and a.query ~ $2
          and a.pid <> all($3::int[])`, [blockers, queryPattern, exclude]);
      if (rows.length === 1) return rows[0]!.pid;
      if (rows.length > 1) throw new Error(`Ambiguous lock wait for ${queryPattern}: ${JSON.stringify(rows)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    const { rows } = await h.sql.query(`select pid, wait_event_type, wait_event, query,
      pg_blocking_pids(pid) as blockers from pg_stat_activity where datname = current_database()`);
    throw new Error(`API did not block on ${queryPattern} behind ${blockers} within 5s: ${JSON.stringify(rows)}`);
  };
  const withLock = async <T>(query: string, values: string[], run: (barrier: {
    pid: number;
    release: () => Promise<void>;
    start: (request: Promise<ApiResponse>) => Promise<ApiResponse>;
  }) => Promise<T>) => {
    const connection = await h.sql.connect();
    const pending: Promise<ApiResponse>[] = [];
    try {
      await connection.query("begin");
      await connection.query(query, values);
      const { rows: [backend] } = await connection.query<{ pid: number }>("select pg_backend_pid() as pid");
      return await run({
        pid: backend!.pid,
        release: async () => { await connection.query("commit"); },
        start: (request) => {
          pending.push(request);
          void request.catch(() => undefined);
          return request;
        },
      });
    } finally {
      await connection.query("rollback");
      connection.release();
      await Promise.allSettled(pending);
    }
  };
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
    expect((await h.sql.query("select action, entity_type, entity_id, before, after from audit_events where entity_id = $1", [res.body.id])).rows).toEqual([{
      action: "route.create", entity_type: "route", entity_id: res.body.id, before: null, after: routePayload(res.body),
    }]);
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

  it.each([
    ["POST", "v1", "route"], ["POST", "v2", "route"],
    ["PUT", "v1", "route"], ["PUT", "v2", "route"],
    ["POST", "v1", "delete"], ["POST", "v2", "delete"],
    ["PUT", "v1", "delete"], ["PUT", "v2", "delete"],
  ] as const)("serializes v2 %s and %s service deletion with %s first", async (method, deleteApi, first) => {
    const ws = (await h.api("POST", "/environments", { name: uniq("ws-delete") })).body.id as string;
    const svc = await h.api("POST", `/environments/${ws}/services`, { name: "target", protocol: "http", host: "target.example.com", port: 80 });
    expect(svc.status).toBe(201);
    // Rebinding from a different service lets DELETE win for PUT too.
    let original: Record<string, unknown> | undefined;
    if (method === "PUT") {
      const source = await h.api("POST", `/environments/${ws}/services`, { name: "source", protocol: "http", host: "source.example.com", port: 80 });
      expect(source.status).toBe(201);
      const route = await v2(h.api, "POST", `/workspaces/${ws}/routes`, { name: uniq("original"), serviceId: source.body.id, paths: ["/original"] });
      expect(route.status).toBe(201);
      original = route.body;
    }
    const routeId = original?.id;
    const before = (await h.sql.query("select * from routes where environment_id = $1", [ws])).rows;
    const ids = await auditIds(ws);
    const body = { name: uniq("contested"), serviceId: svc.body.id as string, paths: ["/changed"] };
    const write = () => v2(h.api, method, `/workspaces/${ws}/routes${routeId ? `/${routeId}` : ""}`, body);
    const remove = () => deleteApi === "v2"
      ? v2(h.api, "DELETE", `/workspaces/${ws}/services/${svc.body.id}`)
      : h.api("DELETE", `/environments/${ws}/services/${svc.body.id}`);
    const [written, deleted] = await withLock(
      first === "route"
        ? "select 1 from services where id = $1 for update"
        : "select 1 from environments where id = $1 for no key update",
      [first === "route" ? svc.body.id : ws],
      async ({ pid, release, start }) => {
        if (first === "route") {
          // The route owns the workspace and waits at its FK; DELETE queues on the workspace.
          const writing = start(write());
          const writerPid = await waitForLock([pid], '(insert into|update) "routes"');
          const deleting = start(remove());
          await waitForLock([writerPid], "pg_advisory_xact_lock\\(hashtextextended");
          await release();
          return Promise.all([writing, deleting]);
        }
        // DELETE holds the service and waits on the environment (v2 checks its mode before deleting).
        const deleting = start(remove());
        const deletePid = await waitForLock([pid], deleteApi === "v2" ? 'from "environments".*for no key update' : 'update "environments"');
        const writing = start(write());
        await waitForLock([deletePid], "pg_advisory_xact_lock\\(hashtextextended");
        await release();
        return Promise.all([writing, deleting]);
      });
    expect((await h.sql.query(`select r.id from routes r left join services s
      on s.id = r.service_id and s.environment_id = r.environment_id
      where r.environment_id = $1 and s.id is null`, [ws])).rows).toEqual([]);
    const remaining = (await h.sql.query("select id from services where id = $1", [svc.body.id])).rows;
    const stored = (await h.sql.query("select * from routes where environment_id = $1", [ws])).rows;
    if (first === "route") {
      expect(written.status, JSON.stringify(written.body)).toBe(method === "POST" ? 201 : 200);
      expect([deleted.status, deleted.body.detail]).toEqual([409, expect.stringMatching(/route|referenced/)]);
      expect(remaining).toEqual([{ id: svc.body.id }]);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ id: written.body.id, name: body.name, service_id: svc.body.id, paths: body.paths, strip_path: false, path_compatibility: "workspace-default" });
      expect((await v2(h.api, "GET", `/workspaces/${ws}/routes/${written.body.id}`)).body).toEqual(written.body);
      expect(await eventsSince(ws, ids)).toEqual([{
        action: method === "POST" ? "route.create" : "route.update", entity_type: "route", entity_id: written.body.id,
        before: original ? routePayload(original) : null, after: routePayload(written.body),
      }]);
    } else {
      expect([written.status, written.body.errors?.[0]?.path], JSON.stringify(written.body)).toEqual([422, "serviceId"]);
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(204);
      expect(remaining).toEqual([]);
      expect(stored).toEqual(before);
      expect(await eventsSince(ws, ids)).toEqual([{
        action: "service.delete", entity_type: "service", entity_id: svc.body.id, before: svc.body, after: null,
      }]);
    }
    if (original) {
      const events = (await h.sql.query("select action, before, after from audit_events where entity_id = $1 order by at, id", [routeId])).rows;
      expect(events).toEqual([
        { action: "route.create", before: null, after: routePayload(original) },
        ...(first === "route" ? [{ action: "route.update", before: routePayload(original), after: routePayload(written.body) }] : []),
      ]);
      if (events.length === 2) expect(events[1]!.before).toEqual(events[0]!.after);
    }
  });

  it.each(["v1", "v2"] as const)("keeps complete, continuous audits when %s edits before the other API", async (first) => {
    const ws = (await h.api("POST", "/environments", { name: uniq("ws-audit") })).body.id as string;
    const svc = (await h.api("POST", `/environments/${ws}/services`, { name: "svc", protocol: "http", host: "audit.example.com", port: 80 })).body.id as string;
    const initial = await v2(h.api, "POST", `/workspaces/${ws}/routes`, { name: uniq("r"), serviceId: svc, paths: ["/a"] });
    expect(initial.status).toBe(201);
    const r = initial.body;
    const edit = (api: "v1" | "v2", path: string) => api === "v2"
      ? v2(h.api, "PUT", `/workspaces/${ws}/routes/${r.id}`, { name: r.name, serviceId: svc, paths: [path] })
      : h.api("PUT", `/environments/${ws}/routes/${r.id}`, { name: r.name, serviceId: svc, paths: [path], stripPath: false });
    const [one, two] = await withLock("select 1 from routes where id = $1 for update", [r.id], async ({ pid, release, start }) => {
      const writing = start(edit(first, "/b"));
      const writerPid = await waitForLock([pid], '(from|update) "routes"');
      const next = start(edit(first === "v1" ? "v2" : "v1", "/c"));
      await waitForLock([writerPid], "pg_advisory_xact_lock\\(hashtextextended");
      await release();
      return Promise.all([writing, next]);
    });
    for (const res of [one, two]) expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(one.body.paths).toEqual(["/b"]);
    expect(two.body.paths).toEqual(["/c"]);
    expect((await h.api("GET", `/environments/${ws}/routes/${r.id}`)).body).toEqual(routePayload(two.body));
    // Transaction start times can predate lock acquisition: compare the enforced order, not UUIDs or timestamps.
    const events = (await h.sql.query("select action, entity_type, entity_id, before, after from audit_events where entity_id = $1", [r.id])).rows;
    const expected = [
      { action: "route.create", entity_type: "route", entity_id: r.id, before: null, after: routePayload(r) },
      { action: "route.update", entity_type: "route", entity_id: r.id, before: routePayload(r), after: routePayload(one.body) },
      { action: "route.update", entity_type: "route", entity_id: r.id, before: routePayload(one.body), after: routePayload(two.body) },
    ];
    expect(events).toHaveLength(expected.length);
    expect(events).toEqual(expect.arrayContaining(expected));
    const firstEvent = events.find((e) => e.action === "route.update" && e.after.paths[0] === "/b");
    const secondEvent = events.find((e) => e.action === "route.update" && e.after.paths[0] === "/c");
    expect(firstEvent?.before).toEqual(events.find((e) => e.action === "route.create")?.after);
    expect(secondEvent?.before).toEqual(firstEvent?.after);
  });

  it.each([
    ["v1", "POST"], ["v1", "PUT"], ["v2", "POST"], ["v2", "PUT"],
  ] as const)("refuses pending %s %s after the guard when archival commits first", async (api, method) => {
    const ws = (await h.api("POST", "/environments", { name: uniq("ws-archive") })).body.id as string;
    const svc = (await h.api("POST", `/environments/${ws}/services`, { name: "svc", protocol: "http", host: "archive.example.com", port: 80 })).body.id as string;
    const initial = await v2(h.api, "POST", `/workspaces/${ws}/routes`, { name: uniq("r"), serviceId: svc, paths: ["/a"] });
    expect(initial.status).toBe(201);
    const r = initial.body;
    const workspace = (await v2(h.api, "GET", `/workspaces/${ws}`)).body;
    const before = await draftState(ws);
    const ids = await auditIds(ws);
    const [written, archived] = await withLock("select 1 from environments where id = $1 for no key update", [ws], async ({ pid, release, start }) => {
      // Archive owns its exclusive advisory lock but cannot change status until this environment lock is released.
      const archiving = start(v2(h.api, "POST", `/workspaces/${ws}/archive`));
      const archivePid = await waitForLock([pid], 'from "environments".*for no key update');
      const body = { name: method === "PUT" ? r.name : uniq("pending"), serviceId: svc, paths: ["/pending"], stripPath: false };
      const writing = start(api === "v2"
        ? v2(h.api, method, `/workspaces/${ws}/routes${method === "PUT" ? `/${r.id}` : ""}`, body)
        : h.api(method, `/environments/${ws}/routes${method === "PUT" ? `/${r.id}` : ""}`, body));
      // This query runs inside the mutation, after the guard saw the workspace active. It waits behind archive itself.
      await waitForLock([archivePid], "pg_advisory_xact_lock\\(hashtextextended");
      expect((await h.sql.query("select status from workspaces where id = $1", [ws])).rows).toEqual([{ status: "active" }]);
      await release();
      const archived = await archiving;
      expect(archived.status, JSON.stringify(archived.body)).toBe(204);
      return [await writing, archived];
    });
    expect(archived.status).toBe(204);
    expect([written.status, written.body.code], JSON.stringify(written.body)).toEqual([409, "workspace-archived"]);
    expect((await h.sql.query("select status from workspaces where id = $1", [ws])).rows).toEqual([{ status: "archived" }]);
    const after = await draftState(ws);
    expect(after).toEqual({ ...before, environment: { ...before.environment, updated_at: after.environment.updated_at }, audits: after.audits });
    expect(after.audits.filter((event: { id: string }) => ids.includes(event.id))).toEqual(before.audits);
    expect(await eventsSince(ws, ids)).toEqual([{
      action: "workspace.archive", entity_type: "workspace", entity_id: ws,
      before: workspace, after: { ...workspace, status: "archived" },
    }]);
    expect((await h.sql.query("select action, before, after from audit_events where entity_id = $1", [r.id])).rows).toEqual([
      { action: "route.create", before: null, after: routePayload(r) },
    ]);
    const frozen = await draftState(ws);
    const late = api === "v2"
      ? await v2(h.api, method, `/workspaces/${ws}/routes${method === "PUT" ? `/${r.id}` : ""}`, { name: r.name, serviceId: svc, paths: ["/late"] })
      : await h.api(method, `/environments/${ws}/routes${method === "PUT" ? `/${r.id}` : ""}`, { name: r.name, serviceId: svc, paths: ["/late"], stripPath: false });
    expect([late.status, late.body.code]).toEqual([409, "workspace-archived"]);
    expect(await draftState(ws)).toEqual(frozen);
  });

  it("needs gateway.write in the workspace", async () => {
    const viewer = await h.as("viewer");
    expect((await v2(viewer.api, "POST", `/workspaces/${a}/routes`, { name: uniq("r"), serviceId: svcA, paths: ["/v"] })).status).toBe(403);
  });
});
