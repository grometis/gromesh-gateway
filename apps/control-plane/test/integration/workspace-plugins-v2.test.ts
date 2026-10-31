import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, uniq, type ApiClient, type Harness } from "./harness.js";

const v2 = (api: ApiClient, method: string, ws: string, suffix = "", body?: unknown) => api(method, `/../v2/workspaces/${ws}/plugins${suffix}`, body);
const plugin = (serviceId: string, over: Record<string, unknown> = {}) => ({ name: "cors", scope: { serviceId }, config: {}, ...over });

interface WorkspaceState {
  environment: { name: string; publish_mode: string; current_version: number | null; has_unpublished_changes: boolean };
  workspace: Record<string, unknown>;
  plugins: Record<string, unknown>[];
  audits: { id: string; action: string }[];
  snapshots: Record<string, unknown>[];
  releases: Record<string, unknown>[];
  deployments: Record<string, unknown>[];
}

describe("workspace plugin writes (WS-P1), real PostgreSQL and Kong", () => {
  let h: Harness;
  let a: string;
  let b: string;
  let sa: string;
  let sb: string;
  beforeAll(async () => {
    h = await startHarness({ platformHttpLogEndpoint: "http://collector:8080/kong", autoPublishPollMs: 0 });
    a = (await h.api("POST", "/environments", { name: uniq("plugins-a") })).body.id;
    b = (await h.api("POST", "/environments", { name: uniq("plugins-b") })).body.id;
    const service = async (ws: string) => (await h.api("POST", `/environments/${ws}/services`, { name: uniq("svc"), protocol: "http", host: "echo", port: 80 })).body.id as string;
    sa = await service(a); sb = await service(b);
  });
  afterAll(async () => h?.close());

  it("creates, replaces, lists and deletes only A's draft, audited without snapshots or deployments", async () => {
    const made = await v2(h.api, "POST", a, "", plugin(sa));
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ name: "cors", scope: { serviceId: sa } });
    expect((await v2(h.api, "GET", a, `/${made.body.id}`)).body).toEqual(made.body);
    expect((await v2(h.api, "GET", b, `/${made.body.id}`)).status).toBe(404);
    expect((await v2(h.api, "GET", b)).body.items).toEqual([]);
    expect((await v2(h.api, "PUT", b, `/${made.body.id}`, plugin(sb))).status).toBe(404);
    const changed = await v2(h.api, "PUT", a, `/${made.body.id}`, plugin(sa, { enabled: false }));
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.enabled).toBe(false);
    expect((await v2(h.api, "DELETE", a, `/${made.body.id}`)).status).toBe(204);
    expect((await h.sql.query("select action from audit_events where entity_id = $1 order by at", [made.body.id])).rows.map(r => r.action)).toEqual(["plugin.create", "plugin.update", "plugin.delete"]);
    expect((await h.sql.query("select has_unpublished_changes from environments where id = $1", [a])).rows[0].has_unpublished_changes).toBe(true);
    expect((await h.sql.query("select count(*)::int n from snapshots where environment_id = $1", [a])).rows[0].n).toBe(0);
    expect((await h.sql.query("select count(*)::int n from deployments where members @> jsonb_build_array(jsonb_build_object('workspaceId', $1::text))", [a])).rows[0].n).toBe(0);
  });

  it("rejects foreign service, route, consumer and anonymous references on POST and PUT", async () => {
    const route = (await h.api("POST", `/environments/${b}/routes`, { name: uniq("route"), serviceId: sb, paths: ["/b"] })).body.id;
    const consumer = (await h.api("POST", `/environments/${b}/consumers`, { username: uniq("foreign") })).body.id;
    const own = await v2(h.api, "POST", a, "", plugin(sa));
    expect(own.status).toBe(201);
    for (const [path, body] of [
      ["scope.serviceId", plugin(sb)],
      ["scope.routeId", plugin(sa, { scope: { routeId: route } })],
      ["scope.consumerId", plugin(sa, { scope: { consumerId: consumer } })],
      ["config.anonymous", plugin(sa, { name: "key-auth", config: { anonymous: consumer } })],
    ] as const) {
      for (const method of ["POST", "PUT"]) {
        const res = await v2(h.api, method, a, method === "PUT" ? `/${own.body.id}` : "", body);
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(res.body.errors).toContainEqual(expect.objectContaining({ path }));
      }
    }
    await v2(h.api, "DELETE", a, `/${own.body.id}`);
  });

  it("enforces server RBAC and privileged capabilities including replacing/deleting an existing privileged plugin", async () => {
    const editor = await h.as("editor");
    const viewer = await h.as("viewer");
    const body = plugin(sa, { name: "pre-function", config: { access: ["return"] } });
    expect((await v2(viewer.api, "POST", a, "", plugin(sa))).status).toBe(403);
    expect((await v2(editor.api, "POST", a, "", body)).status).toBe(403);
    const made = await v2(h.api, "POST", a, "", body);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect((await v2(editor.api, "PUT", a, `/${made.body.id}`, plugin(sa))).status).toBe(403);
    expect((await v2(editor.api, "DELETE", a, `/${made.body.id}`)).status).toBe(403);
    expect((await v2(h.api, "DELETE", a, `/${made.body.id}`)).status).toBe(204);
  });

  it("reserves platform mandatory names and product names in every scope, including legacy rows", async () => {
    for (const name of ["prometheus", "http-log", "gromesh-workspace", "gromesh-route-guard"]) {
      const res = await v2(h.api, "POST", a, "", plugin(sa, { name, config: name === "http-log" ? { http_endpoint: "http://logs:8080" } : {} }));
      expect(res.status, JSON.stringify(res.body)).toBe(422);
    }
    // Old v1 rows cannot be used as a PUT/DELETE path around the v2 reservation.
    const old = await h.api("POST", `/environments/${a}/plugins`, plugin(sa, { name: "prometheus" }));
    expect(old.status).toBe(201);
    expect((await v2(h.api, "PUT", a, `/${old.body.id}`, plugin(sa))).status).toBe(422);
    expect((await v2(h.api, "DELETE", a, `/${old.body.id}`)).status).toBe(422);
    expect((await h.api("DELETE", `/environments/${a}/plugins/${old.body.id}`)).status).toBe(204);
    expect((await v2(h.api, "DELETE", a, "/14f9de7e-3701-4c69-b7f7-b8b5622c0101")).status).toBe(404);
  });

  it("validates pinned catalog fields and actual Kong constraints with 422 field paths; forbids empty scope", async () => {
    for (const [body, path] of [
      [plugin(sa, { name: "rate-limiting", config: { minute: "wrong" } }), "config.minute"],
      [plugin(sa, { config: { invented: true } }), "config.invented"],
      [plugin(sa, { scope: {} }), "scope"],
      [plugin(sa, { name: "ldap-auth" }), "name"],
      [plugin(sa, { tags: ["gromesh-platform"] }), "tags.0"],
    ] as const) {
      const res = await v2(h.api, "POST", a, "", body);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.errors).toContainEqual(expect.objectContaining({ path }));
    }
  });

  it("allows one effective authenticator and rejects a second mechanism or consumer-scoped authenticator", async () => {
    const route = await h.api("POST", `/environments/${a}/routes`, { name: uniq("auth-route"), serviceId: sa, paths: ["/auth"] });
    expect(route.status).toBe(201);
    const first = await v2(h.api, "POST", a, "", plugin(sa, { name: "key-auth" }));
    expect(first.status).toBe(201);
    const second = await v2(h.api, "POST", a, "", plugin(sa, { name: "basic-auth", scope: { routeId: route.body.id } }));
    expect([second.status, second.body.errors?.[0]?.path]).toEqual([422, "name"]);
    const consumer = await h.api("POST", `/environments/${a}/consumers`, { username: uniq("auth-consumer") });
    const byConsumer = await v2(h.api, "POST", a, "", plugin(sa, { name: "jwt", scope: { consumerId: consumer.body.id } }));
    expect(byConsumer.status).toBe(422);
    const disabled = await v2(h.api, "POST", a, "", plugin(sa, { name: "basic-auth", enabled: false }));
    expect(disabled.status).toBe(201);
    const enabled = await v2(h.api, "PUT", a, `/${disabled.body.id}`, plugin(sa, { name: "basic-auth", enabled: true }));
    expect(enabled.status).toBe(422);
    expect((await v2(h.api, "POST", a, "", plugin(sa, { name: "key-auth" }))).status).toBe(409);
    const other = await v2(h.api, "POST", b, "", plugin(sb, { name: "key-auth" }));
    expect(other.status).toBe(201);
    for (const row of [first, disabled]) await v2(h.api, "DELETE", a, `/${row.body.id}`);
    await v2(h.api, "DELETE", b, `/${other.body.id}`);
  });

  it("redacts stored secrets from every response, audit and diff and preserves REDACTED on replace", async () => {
    const secret = "plugins-v2-secret-321";
    const body = plugin(sa, { name: "rate-limiting", config: { minute: 10, policy: "local", redis: { password: secret } } });
    const made = await v2(h.api, "POST", a, "", body);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.config.redis.password).toBe("REDACTED");
    const id = made.body.id as string;
    const changed = await v2(h.api, "PUT", a, `/${id}`, { ...body, config: { minute: 20, policy: "local", redis: { password: "REDACTED" } } });
    expect(changed.status).toBe(200);
    const responses = [await v2(h.api, "GET", a), await v2(h.api, "GET", a, `/${id}`), await h.api("GET", `/environments/${a}/publish-preview`)];
    expect(responses.map(r => r.status)).toEqual([200, 200, 200]);
    expect(JSON.stringify(responses)).not.toContain(secret);
    const stored = (await h.sql.query("select config from plugins where id = $1", [id])).rows[0].config;
    expect(stored.redis.password).toMatch(/^enc:/);
    await v2(h.api, "DELETE", a, `/${id}`);
    const events = (await h.sql.query("select before, after from audit_events where entity_id = $1", [id])).rows;
    expect(events).toHaveLength(3);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain("enc:");
  });

  it("refuses archived and auto-publishing workspaces on all writes, without changing the draft or auditing", async () => {
    for (const state of ["archived", "auto"] as const) {
      const ws = (await h.api("POST", "/environments", { name: uniq(state) })).body.id as string;
      const svc = (await h.api("POST", `/environments/${ws}/services`, { name: uniq("s"), protocol: "http", host: "echo", port: 80 })).body.id as string;
      const row = (await h.api("POST", `/environments/${ws}/plugins`, plugin(svc))).body;
      if (state === "archived") expect((await h.api("POST", `/../v2/workspaces/${ws}/archive`)).status).toBe(204);
      else await h.sql.query("update environments set publish_mode = 'auto' where id = $1", [ws]);
      const before = (await h.sql.query("select config, enabled, updated_at from plugins where id = $1", [row.id])).rows;
      const audits = (await h.sql.query("select count(*)::int n from audit_events where environment_id = $1", [ws])).rows;
      for (const method of ["POST", "PUT", "DELETE"]) {
        const res = await v2(h.api, method, ws, method === "POST" ? "" : `/${row.id}`, method === "DELETE" ? undefined : plugin(svc, { enabled: false }));
        expect([res.status, res.body.code], JSON.stringify(res.body)).toEqual([409, state === "auto" ? "auto-publish" : "workspace-archived"]);
      }
      expect((await h.sql.query("select config, enabled, updated_at from plugins where id = $1", [row.id])).rows).toEqual(before);
      expect((await h.sql.query("select count(*)::int n from audit_events where environment_id = $1", [ws])).rows).toEqual(audits);
    }
  });

  const state = async (ws: string) => (await h.sql.query<WorkspaceState>(`select to_jsonb(e) as environment,
    (select to_jsonb(w) from workspaces w where w.id = e.id) as workspace,
    coalesce((select jsonb_agg(p order by p.id) from plugins p where p.environment_id = e.id), '[]'::jsonb) as plugins,
    coalesce((select jsonb_agg(a order by a.id) from audit_events a where a.environment_id = e.id), '[]'::jsonb) as audits,
    coalesce((select jsonb_agg(s order by s.version) from snapshots s where s.environment_id = e.id), '[]'::jsonb) as snapshots,
    coalesce((select jsonb_agg(r order by r.version) from releases r where r.workspace_id = e.id), '[]'::jsonb) as releases,
    coalesce((select jsonb_agg(d order by d.epoch, d.revision) from deployments d
      where d.members @> jsonb_build_array(jsonb_build_object('workspaceId', e.id))), '[]'::jsonb) as deployments
    from environments e where e.id = $1`, [ws])).rows[0]!;
  const raceFixture = async (method: "POST" | "PUT") => {
    const env = await h.api("POST", "/environments", { name: uniq("plugin-race") });
    expect(env.status).toBe(201);
    const ws = env.body.id as string;
    const service = await h.api("POST", `/environments/${ws}/services`, { name: "svc", protocol: "http", host: "echo", port: 80 });
    expect(service.status).toBe(201);
    const serviceId = service.body.id as string;
    let suffix = "";
    if (method === "PUT") {
      const existing = await v2(h.api, "POST", ws, "", plugin(serviceId));
      expect(existing.status).toBe(201);
      suffix = `/${existing.body.id}`;
    }
    expect((await h.api("POST", `/environments/${ws}/snapshots`, {})).status).toBe(201);
    return {
      ws, serviceId,
      write: () => v2(h.api, method, ws, suffix, plugin(serviceId, { enabled: false, config: { origins: ["https://draft.example.com"] } })),
    };
  };
  // Synchronize on PostgreSQL wait edges, without timing-based sleeps or application mocks.
  const waitFor = async (blocker: number, pattern: string) => {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const { rows } = await h.sql.query<{ pid: number }>(`select pid from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and $1 = any(pg_blocking_pids(pid)) and query ~ $2`, [blocker, pattern]);
      if (rows.length === 1) return rows[0]!.pid;
    }
    throw new Error(`No lock wait for ${pattern} behind ${blocker}`);
  };
  const workspaceWait = "pg_advisory_xact_lock\\(hashtextextended";
  const barrier = async (query: string, ws: string, run: (pid: number, release: () => Promise<void>, start: <T>(p: Promise<T>) => Promise<T>) => Promise<void>) => {
    const holder = await h.sql.connect();
    const pending: Promise<unknown>[] = [];
    try {
      await holder.query("begin");
      await holder.query(query, [ws]);
      const { rows: [backend] } = await holder.query<{ pid: number }>("select pg_backend_pid() as pid");
      await run(backend!.pid, async () => { await holder.query("commit"); }, (p) => {
        pending.push(p);
        void p.catch(() => undefined);
        return p;
      });
    } finally {
      await holder.query("rollback");
      holder.release();
      await Promise.allSettled(pending);
    }
  };
  const noEntityLocks = async (pid: number) => {
    expect((await h.sql.query("select relation::regclass::text from pg_locks where pid = $1 and mode = 'RowExclusiveLock'", [pid])).rows).toEqual([]);
  };
  const unchangedPublication = (before: WorkspaceState, after: WorkspaceState) => {
    expect(before.snapshots).toHaveLength(1);
    expect(after.snapshots).toEqual(before.snapshots);
    expect(after.releases).toEqual(before.releases);
    expect(after.deployments).toEqual(before.deployments);
    expect(after.workspace).toEqual(before.workspace);
  };
  const auditActions = (before: WorkspaceState, after: WorkspaceState) => after.audits
    .filter(a => !before.audits.some(b => b.id === a.id)).map(a => a.action).sort();

  it.each(["POST", "PUT"] as const)("%s v2 waits for publishMode to commit auto, then refuses without effects", async (method) => {
    const f = await raceFixture(method);
    const before = await state(f.ws);
    await barrier("select 1 from environments where id = $1 for update", f.ws, async (pid, release, start) => {
      const switching = start(h.api("PATCH", `/environments/${f.ws}`, { name: before.environment.name, publishMode: "auto" }));
      const switcher = await waitFor(pid, 'from "environments".*for update');
      const writing = start(f.write());
      const writer = await waitFor(switcher, workspaceWait);
      await noEntityLocks(writer);
      expect(await state(f.ws)).toEqual(before);
      await release();
      expect((await switching).status).toBe(200);
      const res = await writing;
      expect([res.status, res.body.code], JSON.stringify(res.body)).toEqual([409, "auto-publish"]);
      expect(res.contentType).toContain("application/problem+json");
    });
    const after = await state(f.ws);
    expect(after.plugins).toEqual(before.plugins);
    expect(after.environment).toMatchObject({ publish_mode: "auto", current_version: 1, has_unpublished_changes: false });
    expect(auditActions(before, after)).toEqual(["environment.update"]);
    unchangedPublication(before, after);
  });

  it.each(["POST", "PUT"] as const)("%s v2 holds the workspace through commit before publishMode changes, writing only the draft", async (method) => {
    const f = await raceFixture(method);
    const before = await state(f.ws);
    const action = method === "POST" ? "plugin.create" : "plugin.update";
    // Pause after the plugin write and dirty mark, at audit insertion, to detect early lock release.
    await h.sql.query(`create function ws_p1_pause_plugin() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(232, hashtext(TG_ARGV[0])); return NEW; end $$`);
    try {
      await h.sql.query(`create trigger ws_p1_pause_plugin before insert on audit_events for each row
        when (NEW.environment_id = '${f.ws}'::uuid and NEW.action = '${action}')
        execute function ws_p1_pause_plugin('${f.ws}')`);
      await barrier("select pg_advisory_xact_lock(232, hashtext($1))", f.ws, async (pid, release, start) => {
        const writing = start(f.write());
        const writer = await waitFor(pid, 'insert into "audit_events"');
        const switching = start(h.api("PATCH", `/environments/${f.ws}`, { name: before.environment.name, publishMode: "auto" }));
        const switcher = await waitFor(writer, workspaceWait);
        await noEntityLocks(switcher);
        expect(await state(f.ws)).toEqual(before);
        await release();
        const written = await writing;
        expect(written.status, JSON.stringify(written.body)).toBe(method === "POST" ? 201 : 200);
        expect((await switching).status).toBe(200);
        const after = await state(f.ws);
        expect(after.plugins).toEqual([expect.objectContaining({
          id: written.body.id, environment_id: f.ws, name: "cors", service_id: f.serviceId,
          enabled: false, config: { origins: ["https://draft.example.com"] },
        })]);
        if (method === "PUT") expect(written.body.id).toBe(before.plugins[0]!.id);
        expect(after.environment).toMatchObject({ publish_mode: "auto", current_version: 1, has_unpublished_changes: true });
        expect(auditActions(before, after)).toEqual(["environment.update", action]);
        unchangedPublication(before, after);
      });
    } finally { await h.sql.query("drop function ws_p1_pause_plugin() cascade"); }
  });

  it("rechecks the current privileged plugin under the workspace lock after a concurrent v1 change", async () => {
    const editor = await h.as("editor");
    const made = await h.api("POST", `/environments/${a}/plugins`, plugin(sa, { name: "request-termination" }));
    const holder = await h.sql.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1::uuid::text, $2))", [a, 0x6772_7761]);
      const pending = v2(editor.api, "PUT", a, `/${made.body.id}`, plugin(sa));
      // Wait for the actual writer to be blocked, not a timing-based assumption.
      const deadline = Date.now() + 4000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        waiting = (await h.sql.query("select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%pg_advisory_xact_lock(%'")).rows.length > 0;
        if (!waiting) await new Promise(r => setTimeout(r, 10));
      }
      expect(waiting).toBe(true);
      await holder.query("update plugins set name = 'pre-function', config = '{\"access\":[\"return\"]}' where id = $1", [made.body.id]);
      await holder.query("commit");
      expect((await pending).status).toBe(403);
    } finally { await holder.query("rollback"); holder.release(); }
    await h.api("DELETE", `/environments/${a}/plugins/${made.body.id}`);
  });
});
